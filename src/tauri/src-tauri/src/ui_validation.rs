//! Validation-only WKWebView interaction and self-capture harness.
//! Compiled only by the explicit macOS `ui-validation` feature.
use block2::RcBlock;
use objc2::runtime::AnyObject;
use objc2::{AnyThread, MainThreadMarker};
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
use objc2_foundation::{NSDictionary, NSError, NSString};
use objc2_web_kit::{WKContentWorld, WKWebView};
use serde::{Deserialize, Serialize};
use std::env;
use std::ffi::CString;
use std::fs;
use std::io::Write;
use std::os::fd::{FromRawFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};
const STAGE_SCRIPT: &str =
    include_str!("../../../../tests/tauri/ui/fixtures/wkSelfCaptureStage.txt");
const STAGE_SCRIPT_SHA256: &str =
    "7fd3959c51193fefec4b9651c254bc47d52aab8c030b38dc5485e40c0d41912b";
const SENTINELS: [&str; 4] = ["cause-first", "pain-owner first", "I-lean", "reference-story led"];
const TARGETS: [&str; 4] = ["economic-buyer-first", "champion-led", "R-lean", "number-anchored opener"];
const EN_LABELS: [&str; 4] = ["economic-buyer-first", "champion-led", "R-lean", "number-anchored opener"];
const ZH_LABELS: [&str; 4] = ["先找经济决策者", "由内部支持者带动", "偏重回应", "以数字锚点开场"];
const EN_GROUP_LABELS: [&str; 4] = ["Pain Chain direction", "Key Players entry point", "Discovery pacing", "Spark-interest story shape"];
const ZH_GROUP_LABELS: [&str; 4] = ["Pain Chain 方向", "Key Players 切入角色", "9-block 节奏", "首次触达故事形态"];

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
enum Stage {
    En,
    Zh,
}

impl Stage {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "en" => Ok(Self::En),
            "zh" => Ok(Self::Zh),
            _ => Err("stage must be en or zh".into()),
        }
    }

    fn slug(self) -> &'static str {
        match self {
            Self::En => "en",
            Self::Zh => "zh",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RequestState {
    JsPending,
    JsStarted,
    JsAccepted,
    SnapshotPending,
    SnapshotAccepted,
    Complete,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum EventKind {
    JavaScriptStart,
    JavaScriptResult,
    Snapshot,
}

#[derive(Debug)]
struct RequestReducer {
    id: u64,
    nonce: String,
    stage: Stage,
    state: RequestState,
}

impl RequestReducer {
    fn new(id: u64, nonce: String, stage: Stage) -> Self {
        Self {
            id,
            nonce,
            stage,
            state: RequestState::JsPending,
        }
    }

    fn accept(
        &mut self,
        id: u64,
        nonce: &str,
        stage: Stage,
        kind: EventKind,
    ) -> Result<(), String> {
        if self.id != id || self.nonce != nonce || self.stage != stage {
            self.state = RequestState::Failed;
            return Err("request identity mismatch".into());
        }
        self.state = match (self.state, kind) {
            (RequestState::JsPending, EventKind::JavaScriptStart) => RequestState::JsStarted,
            (RequestState::JsStarted, EventKind::JavaScriptResult) => RequestState::JsAccepted,
            (RequestState::SnapshotPending, EventKind::Snapshot) => RequestState::SnapshotAccepted,
            _ => {
                self.state = RequestState::Failed;
                return Err("duplicate or out-of-order callback".into());
            }
        };
        Ok(())
    }

    fn begin_snapshot(&mut self) -> Result<(), String> {
        if self.state != RequestState::JsAccepted {
            self.state = RequestState::Failed;
            return Err("snapshot began before JavaScript completion".into());
        }
        self.state = RequestState::SnapshotPending;
        Ok(())
    }

    fn complete(&mut self) -> Result<(), String> {
        if self.state != RequestState::SnapshotAccepted {
            self.state = RequestState::Failed;
            return Err("completion before snapshot".into());
        }
        self.state = RequestState::Complete;
        Ok(())
    }

    fn timeout(&mut self) {
        self.state = RequestState::Failed;
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Viewport {
    width: f64,
    height: f64,
    scale: f64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StageEvidence {
    nonce: String,
    stage: String,
    loaded_language: String,
    loaded_values: Vec<String>,
    language: String,
    document_language: String,
    values: Vec<String>,
    labels: Vec<String>,
    toast: String,
    panel_visible: bool,
    error_hidden: bool,
    viewport: Viewport,
    horizontal_offsets: Vec<f64>, group_bounds: serde_json::Value, control_bounds: serde_json::Value,
    group_label_texts: Vec<String>, group_label_bounds: serde_json::Value,
    reget_assignments: Vec<u32>,
}

fn validate_evidence(evidence: &StageEvidence, nonce: &str, stage: Stage) -> Result<(), String> {
    let (loaded, loaded_language, language, document_language, toast, labels, group_labels) = match stage {
        Stage::En => (
            &SENTINELS[..],
            "auto",
            "en",
            "en",
            "✓ Saved",
            &EN_LABELS[..], &EN_GROUP_LABELS[..],
        ),
        Stage::Zh => (
            &TARGETS[..],
            "en",
            "zh",
            "zh-CN",
            "✓ 已保存",
            &ZH_LABELS[..], &ZH_GROUP_LABELS[..],
        ),
    };
    if evidence.nonce != nonce
        || evidence.stage != stage.slug()
        || evidence
            .loaded_values
            .iter()
            .map(String::as_str)
            .ne(loaded.iter().copied())
        || evidence.loaded_language != loaded_language
        || evidence
            .values
            .iter()
            .map(String::as_str)
            .ne(TARGETS.iter().copied())
        || evidence.language != language
        || evidence.document_language != document_language
        || evidence.toast != toast
        || evidence
            .labels
            .iter()
            .map(String::as_str)
            .ne(labels.iter().copied())
        || evidence.reget_assignments != [2, 2, 2, 2]
        || evidence.group_label_texts.iter().map(String::as_str).ne(group_labels.iter().copied())
        || !evidence.panel_visible
        || !evidence.error_hidden
        || evidence.horizontal_offsets != [0.0, 0.0, 0.0]
    {
        return Err("rendered evidence contract mismatch".into());
    }
    Ok(())
}

fn validate_capture_dimensions(viewport: &Viewport, expected: (u32, u32)) -> Result<(), String> {
    for value in [viewport.width, viewport.height, viewport.scale] {
        if !value.is_finite() || value <= 0.0 {
            return Err("invalid viewport".into());
        }
    }
    let css_width = viewport.width * viewport.scale;
    let css_height = viewport.height * viewport.scale;
    if css_width > u32::MAX as f64 || css_height > u32::MAX as f64 {
        return Err("viewport overflow".into());
    }
    if expected.0 != css_width.round() as u32
        || expected.1 < css_height.round() as u32
        || expected.1 - css_height.round() as u32 > (100.0 * viewport.scale).round() as u32
    {
        return Err("native capture size is inconsistent with CSS viewport".into());
    }
    Ok(())
}

fn validate_png(
    png: &[u8],
    viewport: &Viewport,
    expected: (u32, u32),
) -> Result<(u32, u32), String> {
    if png.len() < 24 || &png[..8] != b"\x89PNG\r\n\x1a\n" || &png[12..16] != b"IHDR" {
        return Err("invalid or truncated PNG IHDR".into());
    }
    let width = u32::from_be_bytes(png[16..20].try_into().map_err(|_| "bad width")?);
    let height = u32::from_be_bytes(png[20..24].try_into().map_err(|_| "bad height")?);
    validate_capture_dimensions(viewport, expected)?;
    if width == 0 || height == 0 || (width, height) != expected {
        return Err(format!(
            "PNG dimension mismatch: {:?} != {expected:?}",
            (width, height)
        ));
    }
    Ok((width, height))
}

#[derive(Debug)]
struct SafeStageDir {
    fd: RawFd,
    path: PathBuf,
    dev: u64,
    ino: u64,
    uid: u32,
}

impl SafeStageDir {
    fn open(home: &Path, stage_dir: &Path, stage: Stage) -> Result<Self, String> {
        if !home.is_absolute() || !stage_dir.is_absolute() {
            return Err("validation paths must be absolute".into());
        }
        let canonical_home = home
            .canonicalize()
            .map_err(|e| format!("canonical home: {e}"))?;
        let canonical_stage = stage_dir
            .canonicalize()
            .map_err(|e| format!("canonical stage: {e}"))?;
        let expected = canonical_home.join("ui-validation").join(stage.slug());
        if canonical_stage != expected || stage_dir != canonical_stage {
            return Err("stage directory is not the exact canonical stage path".into());
        }
        let metadata =
            fs::symlink_metadata(&canonical_stage).map_err(|e| format!("stage metadata: {e}"))?;
        validate_directory_metadata(metadata.mode(), metadata.uid(), unsafe { libc::geteuid() })?;
        if fs::read_dir(&canonical_stage)
            .map_err(|e| format!("stage read: {e}"))?
            .next()
            .is_some()
        {
            return Err("stage directory must be empty".into());
        }
        let fd = open_stage_components(&canonical_home, &["ui-validation", stage.slug()])?;
        let owner = Self {
            fd,
            path: canonical_stage,
            dev: metadata.dev(),
            ino: metadata.ino(),
            uid: metadata.uid(),
        };
        owner.verify_parent()?;
        Ok(owner)
    }

    fn verify_parent(&self) -> Result<(), String> {
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe { libc::fstat(self.fd, stat.as_mut_ptr()) } != 0 {
            return Err(format!("fstat stage: {}", std::io::Error::last_os_error()));
        }
        let stat = unsafe { stat.assume_init() };
        if stat.st_dev as u64 != self.dev
            || stat.st_ino as u64 != self.ino
            || stat.st_uid != self.uid
        {
            return Err("stage directory identity changed".into());
        }
        let path_meta =
            fs::symlink_metadata(&self.path).map_err(|e| format!("stage path identity: {e}"))?;
        if path_meta.file_type().is_symlink()
            || path_meta.dev() != self.dev
            || path_meta.ino() != self.ino
            || path_meta.uid() != self.uid
        {
            return Err("stage path was replaced".into());
        }
        Ok(())
    }

    fn write_leaf(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        if name.contains('/') || name.is_empty() {
            return Err("invalid output leaf".into());
        }
        self.verify_parent()?;
        let leaf = CString::new(name).map_err(|_| "NUL in leaf")?;
        let fd = unsafe {
            libc::openat(
                self.fd,
                leaf.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err(format!(
                "exclusive output create: {}",
                std::io::Error::last_os_error()
            ));
        }
        let mut file = unsafe { fs::File::from_raw_fd(fd) };
        let meta = file
            .metadata()
            .map_err(|e| format!("output metadata: {e}"))?;
        if !meta.is_file() || meta.nlink() != 1 || meta.uid() != self.uid {
            return Err("unsafe output leaf metadata".into());
        }
        file.write_all(bytes)
            .map_err(|e| format!("output write: {e}"))?;
        file.sync_all().map_err(|e| format!("output sync: {e}"))?;
        self.verify_parent()?;
        Ok(())
    }
}

fn validate_directory_metadata(mode: u32, uid: u32, expected_uid: u32) -> Result<(), String> {
    if mode & u32::from(libc::S_IFMT) != u32::from(libc::S_IFDIR)
        || mode & 0o777 != 0o700
        || uid != expected_uid
    {
        return Err("stage directory owner, type, or mode mismatch".into());
    }
    Ok(())
}

fn open_stage_components(home: &Path, components: &[&str]) -> Result<RawFd, String> {
    let home_path = CString::new(home.as_os_str().as_bytes()).map_err(|_| "NUL in home path")?;
    let mut fd = unsafe {
        libc::open(
            home_path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(format!(
            "open validation home: {}",
            std::io::Error::last_os_error()
        ));
    }
    for component in components {
        let name = CString::new(*component).map_err(|_| "NUL in path component")?;
        let next = unsafe {
            libc::openat(
                fd,
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        unsafe { libc::close(fd) };
        if next < 0 {
            return Err(format!(
                "open stage component: {}",
                std::io::Error::last_os_error()
            ));
        }
        fd = next;
    }
    Ok(fd)
}

impl Drop for SafeStageDir {
    fn drop(&mut self) {
        unsafe { libc::close(self.fd) };
    }
}

struct Activation {
    stage: Stage,
    nonce: String,
    output: SafeStageDir,
}

fn activation_from_env() -> Result<Activation, String> {
    let home =
        PathBuf::from(env::var("FRONDOSE_HOME_BASE").map_err(|_| "missing FRONDOSE_HOME_BASE")?);
    let output = PathBuf::from(
        env::var("FRONDOSE_UI_VALIDATION_DIR").map_err(|_| "missing validation dir")?,
    );
    let stage_raw =
        env::var("FRONDOSE_UI_VALIDATION_STAGE").map_err(|_| "missing validation stage")?;
    let nonce = env::var("FRONDOSE_UI_VALIDATION_NONCE").map_err(|_| "missing validation nonce")?;
    let (stage, nonce) = validate_stage_nonce(&stage_raw, nonce)?;
    Ok(Activation {
        stage,
        nonce,
        output: SafeStageDir::open(&home, &output, stage)?,
    })
}

fn validate_stage_nonce(stage_raw: &str, nonce: String) -> Result<(Stage, String), String> {
    let stage = Stage::parse(stage_raw)?;
    if nonce.len() < 24
        || !nonce
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("invalid validation nonce".into());
    }
    Ok((stage, nonce))
}

fn payload(stage: Stage, nonce: &str) -> String {
    let (loaded_values, loaded_language, target_language, toast, lang, labels, group_labels) = match stage {
        Stage::En => (&SENTINELS, "auto", "en", "✓ Saved", "en", &EN_LABELS, &EN_GROUP_LABELS),
        Stage::Zh => (&TARGETS, "en", "zh", "✓ 已保存", "zh-CN", &ZH_LABELS, &ZH_GROUP_LABELS),
    };
    serde_json::json!({
        "stage": stage.slug(), "nonce": nonce, "loadedValues": loaded_values,
        "loadedLanguage": loaded_language, "targetValues": TARGETS,
        "targetLanguage": target_language, "expectedToast": toast,
        "expectedDocumentLang": lang, "expectedLabels": labels,
        "expectedGroupLabels": group_labels,
        "staleToast": "", "timeoutMs": 8000
    })
    .to_string()
}

fn fail(app: &AppHandle, message: impl AsRef<str>) {
    eprintln!("[frondose-ui-validation] {}", message.as_ref());
    app.exit(2);
}

fn dispatch_javascript(
    window: &tauri::WebviewWindow,
    body: String,
    payload_json: String,
    reducer: Arc<Mutex<RequestReducer>>,
    id: u64,
    nonce: String,
    stage: Stage,
    event: EventKind,
) -> Result<mpsc::Receiver<Result<String, String>>, String> {
    let (tx, rx) = mpsc::sync_channel(1);
    window
        .with_webview(move |platform| {
            eprintln!("[frondose-ui-validation] JavaScript dispatch entered main thread");
            let mtm = match MainThreadMarker::new() {
                Some(value) => value,
                None => return drop(tx.send(Err("JavaScript dispatch not on main thread".into()))),
            };
            let webview: &WKWebView = unsafe { &*platform.inner().cast() };
            let world = unsafe { WKContentWorld::pageWorld(mtm) };
            let body = NSString::from_str(&body);
            let key = NSString::from_str("payload");
            let value = NSString::from_str(&payload_json);
            let dictionary = NSDictionary::<NSString, NSString>::from_slices(&[&*key], &[&*value]);
            let block = Box::leak(Box::new(RcBlock::new(
                move |result: *mut AnyObject, error: *mut NSError| {
                    eprintln!("[frondose-ui-validation] JavaScript completion entered");
                    let outcome = if !error.is_null() {
                        let error = unsafe { &*error };
                        let message_key = NSString::from_str("WKJavaScriptExceptionMessage");
                        let exception = error
                            .userInfo()
                            .objectForKey(&message_key)
                            .and_then(|value| value.downcast::<NSString>().ok())
                            .map(|value| value.to_string())
                            .unwrap_or_else(|| "<missing exception message>".into());
                        Err(format!(
                            "JavaScript NSError {}: {}; {exception}",
                            error.code(),
                            error.localizedDescription()
                        ))
                    } else if result.is_null() {
                        Err("JavaScript returned null".into())
                    } else {
                        let object = unsafe { &*result };
                        match object.downcast_ref::<NSString>() {
                            Some(string) => reducer
                                .lock()
                                .map_err(|_| "reducer poisoned".to_string())
                                .and_then(|mut state| state.accept(id, &nonce, stage, event))
                                .map(|_| string.to_string()),
                            None => Err("JavaScript returned non-string".into()),
                        }
                    };
                    let _ = tx.send(terminalize_callback(&reducer, outcome));
                },
            )));
            let args: &NSDictionary<NSString, AnyObject> =
                unsafe { &*((&*dictionary as *const NSDictionary<NSString, NSString>).cast()) };
            unsafe {
                webview.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(
                    &body,
                    Some(args),
                    None,
                    &world,
                    Some(&**block),
                );
            }
        })
        .map_err(|error| format!("schedule JavaScript: {error}"))?;
    Ok(rx)
}

fn receive_javascript_result(
    rx: mpsc::Receiver<Result<String, String>>,
    reducer: &Arc<Mutex<RequestReducer>>,
    timeout: Duration,
) -> Result<String, String> {
    match rx.recv_timeout(timeout) {
        Ok(result) => result,
        Err(_) => {
            reducer
                .lock()
                .map_err(|_| "reducer poisoned".to_string())?
                .timeout();
            Err("JavaScript result callback timeout".into())
        }
    }
}

fn terminalize_callback<T>(
    reducer: &Arc<Mutex<RequestReducer>>,
    outcome: Result<T, String>,
) -> Result<T, String> {
    if outcome.is_err() {
        if let Ok(mut state) = reducer.lock() {
            state.timeout();
        }
    }
    outcome
}

pub fn activate(app: AppHandle) {
    let activation = match activation_from_env() {
        Ok(value) => value,
        Err(error) => return fail(&app, error),
    };
    let window = match app.get_webview_window("main") {
        Some(value) => value,
        None => return fail(&app, "main webview missing"),
    };
    let app_for_thread = app.clone();
    std::thread::spawn(move || {
        // `RunEvent::Ready` precedes the UI's initial sidecar-backed settings load.
        // Wait until that boot navigation/context is stable before retaining state
        // in the page for the second short WebKit call.
        std::thread::sleep(Duration::from_secs(3));
        let id = 1_u64;
        let stage = activation.stage;
        let nonce = activation.nonce.clone();
        let reducer = Arc::new(Mutex::new(RequestReducer::new(id, nonce.clone(), stage)));
        let body = format!(
            "const args=JSON.parse(payload); const retainId='frondose-ui-validation-'+args.nonce; if(document.getElementById(retainId)) return 'duplicate'; const holder=document.createElement('div'); holder.id=retainId; holder.hidden=true; holder.textContent=JSON.stringify({{status:'pending'}}); document.documentElement.append(holder); (async()=>{{ const {{stage,nonce,loadedValues,loadedLanguage,targetValues,targetLanguage,expectedToast,expectedDocumentLang,expectedLabels,expectedGroupLabels,staleToast,timeoutMs}}=args;\n{}\n}})().then(result=>{{holder.textContent=JSON.stringify({{status:'done',result}});}},error=>{{const ids=['settings-axis-painchain','settings-axis-leadrole','settings-axis-discovery','settings-axis-story'];holder.textContent=JSON.stringify({{status:'error',error:String(error),diagnostic:{{panel:document.getElementById('settings-panel')?.className,language:document.getElementById('settings-language')?.value,values:ids.map(id=>document.getElementById(id)?.value),error:document.getElementById('error-banner')?.textContent}}}});}}); return 'started';",
            STAGE_SCRIPT
        );
        let payload_json = payload(stage, &nonce);
        let js_rx = match dispatch_javascript(
            &window,
            body,
            payload_json.clone(),
            reducer.clone(),
            id,
            nonce.clone(),
            stage,
            EventKind::JavaScriptStart,
        ) {
            Ok(value) => value,
            Err(error) => return fail(&app_for_thread, error),
        };
        let started = match js_rx.recv_timeout(Duration::from_secs(4)) {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => return fail(&app_for_thread, error),
            Err(_) => {
                if let Ok(mut state) = reducer.lock() {
                    state.timeout();
                }
                return fail(&app_for_thread, "JavaScript start callback timeout");
            }
        };
        if started != "started" {
            return fail(
                &app_for_thread,
                format!("JavaScript start rejected: {started}"),
            );
        }
        // The product toast auto-dismisses after 2.5s. The retained page task starts
        // after boot has settled and otherwise completes in one turn, so collect its
        // result at 1s and snapshot while the actual success surface is still live.
        std::thread::sleep(Duration::from_secs(1));
        let result_body = "const {nonce}=JSON.parse(payload); const holder=document.getElementById('frondose-ui-validation-'+nonce); return holder?.textContent??JSON.stringify({status:'missing'});".to_string();
        let result_rx = match dispatch_javascript(
            &window,
            result_body,
            payload_json,
            reducer.clone(),
            id,
            nonce.clone(),
            stage,
            EventKind::JavaScriptResult,
        ) {
            Ok(value) => value,
            Err(error) => return fail(&app_for_thread, error),
        };
        let result_envelope =
            match receive_javascript_result(result_rx, &reducer, Duration::from_secs(4)) {
                Ok(value) => value,
                Err(error) => return fail(&app_for_thread, error),
            };
        let envelope: serde_json::Value = match serde_json::from_str(&result_envelope) {
            Ok(value) => value,
            Err(error) => {
                return fail(&app_for_thread, format!("invalid result envelope: {error}"))
            }
        };
        if envelope.get("status").and_then(|value| value.as_str()) != Some("done") {
            return fail(
                &app_for_thread,
                format!("JavaScript stage incomplete: {result_envelope}"),
            );
        }
        let evidence_json = match envelope.get("result").and_then(|value| value.as_str()) {
            Some(value) => value.to_owned(),
            None => return fail(&app_for_thread, "JavaScript result missing"),
        };
        let evidence: StageEvidence = match serde_json::from_str(&evidence_json) {
            Ok(value) => value,
            Err(error) => {
                let detail = serde_json::from_str::<serde_json::Value>(&evidence_json)
                    .ok()
                    .and_then(|value| {
                        value
                            .get("__validationError")
                            .and_then(|item| item.as_str())
                            .map(|message| format!("{message}; payload={evidence_json}"))
                    });
                return fail(
                    &app_for_thread,
                    detail.unwrap_or_else(|| format!("invalid evidence JSON: {error}")),
                );
            }
        };
        if let Err(error) = validate_evidence(&evidence, &nonce, stage) {
            return fail(&app_for_thread, error);
        }
        if let Err(error) = reducer
            .lock()
            .map_err(|_| "reducer poisoned".to_string())
            .and_then(|mut state| state.begin_snapshot())
        {
            return fail(&app_for_thread, error);
        }
        let (png_tx, png_rx) = mpsc::sync_channel::<Result<Vec<u8>, String>>(1);
        let capture_size = match window.inner_size() {
            Ok(size) => (size.width, size.height),
            Err(error) => return fail(&app_for_thread, format!("native capture size: {error}")),
        };
        let png_reducer = reducer.clone();
        let png_nonce = nonce.clone();
        if let Err(error) = window.with_webview(move |platform| {
            eprintln!("[frondose-ui-validation] snapshot dispatch entered main thread");
            let webview: &WKWebView = unsafe { &*platform.inner().cast() };
            let block = Box::leak(Box::new(RcBlock::new(
                move |image: *mut objc2_app_kit::NSImage, error: *mut NSError| {
                    eprintln!("[frondose-ui-validation] snapshot completion entered");
                    let outcome = if !error.is_null() {
                        let error = unsafe { &*error };
                        Err(format!(
                            "snapshot NSError {}: {}",
                            error.code(),
                            error.localizedDescription()
                        ))
                    } else if image.is_null() {
                        Err("snapshot returned null image".into())
                    } else {
                        (|| {
                            png_reducer
                                .lock()
                                .map_err(|_| "reducer poisoned".to_string())?
                                .accept(id, &png_nonce, stage, EventKind::Snapshot)?;
                            let tiff = unsafe { &*image }
                                .TIFFRepresentation()
                                .ok_or("missing TIFF data")?;
                            let bitmap =
                                NSBitmapImageRep::initWithData(NSBitmapImageRep::alloc(), &tiff)
                                    .ok_or("cannot decode TIFF")?;
                            let properties = NSDictionary::new();
                            let png = unsafe {
                                bitmap.representationUsingType_properties(
                                    NSBitmapImageFileType::PNG,
                                    &properties,
                                )
                            }
                            .ok_or("cannot encode PNG")?;
                            Ok(png.to_vec())
                        })()
                    };
                    let _ = png_tx.send(terminalize_callback(&png_reducer, outcome));
                },
            )));
            unsafe { webview.takeSnapshotWithConfiguration_completionHandler(None, &**block) };
        }) {
            return fail(&app_for_thread, format!("schedule snapshot: {error}"));
        }
        let png = match png_rx.recv_timeout(Duration::from_secs(12)) {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => return fail(&app_for_thread, error),
            Err(_) => {
                if let Ok(mut state) = reducer.lock() {
                    state.timeout();
                }
                return fail(&app_for_thread, "snapshot callback timeout");
            }
        };
        let (png_width, png_height) = match validate_png(&png, &evidence.viewport, capture_size) {
            Ok(value) => value,
            Err(error) => return fail(&app_for_thread, error),
        };
        let image_name = format!("settings-{}.png", stage.slug());
        if let Err(error) = activation.output.write_leaf(&image_name, &png) {
            return fail(&app_for_thread, error);
        }
        let manifest = serde_json::json!({
            "stage": stage.slug(), "nonce": nonce, "scriptSha256": STAGE_SCRIPT_SHA256,
            "pngWidth": png_width, "pngHeight": png_height, "evidence": evidence
        });
        let manifest_bytes = match serde_json::to_vec_pretty(&manifest) {
            Ok(value) => value,
            Err(error) => return fail(&app_for_thread, format!("manifest JSON: {error}")),
        };
        if let Err(error) = activation.output.write_leaf("stage.json", &manifest_bytes) {
            return fail(&app_for_thread, error);
        }
        if let Err(error) = reducer
            .lock()
            .map_err(|_| "reducer poisoned".to_string())
            .and_then(|mut state| state.complete())
        {
            return fail(&app_for_thread, error);
        }
        app_for_thread.exit(0);
    });
}

#[cfg(test)]
#[path = "ui_validation_tests.rs"]
mod tests;
