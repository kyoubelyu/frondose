// P-56a M-1 SCAFFOLD: Tauri shell for the v0.5 hover pivot. Throwaway-scope -
// the entire file may be restructured in P-56b/M-2/M-3. Approved-site for
// child_process via tokio::process::Command (see CLAUDE.md HR-8).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use hyper::body::HttpBody;
use hyper::{Body, Client, Method, Request, StatusCode};
use hyperlocal::{UnixClientExt, Uri};
use rand::RngCore;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, RunEvent, WindowEvent};
use tauri_plugin_updater::UpdaterExt;
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, Notify};

/// Per-app state: bearer token + UDS path + sidecar child handle.
struct MaiServeState {
    token: String,
    sock_path: PathBuf,
    parent_dir: PathBuf,
    child: Arc<Mutex<Option<Child>>>,
}

/// Build a hyperlocal URI for a path on the UDS sock.
fn build_uri(sock: &PathBuf, path: &str) -> Uri {
    Uri::new(sock, path).into()
}

/// One-shot UDS HTTP request (no keepalive). Returns response body as Value.
async fn uds_request(
    state: &MaiServeState,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let client = Client::unix();
    let mut req = Request::builder()
        .method(method)
        .uri(build_uri(&state.sock_path, path))
        .header("Authorization", format!("Bearer {}", state.token))
        .header("Host", "localhost");
    let body_bytes = match body {
        Some(v) => {
            req = req.header("Content-Type", "application/json");
            Body::from(serde_json::to_vec(&v).map_err(|e| e.to_string())?)
        }
        None => Body::empty(),
    };
    let req = req.body(body_bytes).map_err(|e| e.to_string())?;
    let res = client.request(req).await.map_err(|e| e.to_string())?;
    let status = res.status();
    let buf = hyper::body::to_bytes(res.into_body())
        .await
        .map_err(|e| e.to_string())?;
    let parsed: Value =
        serde_json::from_slice(&buf).map_err(|e| format!("invalid JSON from mai serve: {}", e))?;
    if status != StatusCode::OK {
        return Err(format!("HTTP {}: {}", status, parsed));
    }
    Ok(parsed)
}

#[tauri::command]
async fn mai_health(state: tauri::State<'_, MaiServeState>) -> Result<Value, String> {
    uds_request(state.inner(), Method::GET, "/health", None).await
}

#[tauri::command]
async fn mai_identity(state: tauri::State<'_, MaiServeState>) -> Result<Value, String> {
    uds_request(state.inner(), Method::GET, "/identity", None).await
}

#[tauri::command]
async fn mai_chrome_ensure(state: tauri::State<'_, MaiServeState>) -> Result<Value, String> {
    uds_request(state.inner(), Method::POST, "/chrome/ensure", Some(json!({}))).await
}

// P-Y6 — in-app settings (auth/identity/soul). Mirror mai_identity → GET /settings;
// mai_set_settings POSTs the masked-safe patch. The serve handler returns a masked view.
#[tauri::command]
async fn mai_get_settings(state: tauri::State<'_, MaiServeState>) -> Result<Value, String> {
    uds_request(state.inner(), Method::GET, "/settings", None).await
}

#[tauri::command]
async fn mai_set_settings(
    state: tauri::State<'_, MaiServeState>,
    settings: Value,
) -> Result<Value, String> {
    uds_request(state.inner(), Method::POST, "/settings", Some(settings)).await
}

// P-58d.1 — manual "Check for updates" trigger (OQ-58d.6). Custom command (no
// plugin command exposed to JS → no capability change). The Settings-panel
// button that calls this ships in P-58d.1-UI.
#[tauri::command]
async fn mai_check_update(app: tauri::AppHandle) -> Result<Value, String> {
    let url = read_update_server_url().ok_or("no update server URL configured")?;
    let endpoint = format!("{}/latest.json", url.trim_end_matches('/'));
    let parsed = endpoint
        .parse()
        .map_err(|e| format!("invalid endpoint {}: {}", endpoint, e))?;
    let updater = app
        .updater_builder()
        .endpoints(vec![parsed])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    match updater.check().await.map_err(|e| e.to_string())? {
        Some(update) => {
            update
                .download_and_install(|_chunk, _total| {}, || {})
                .await
                .map_err(|e| e.to_string())?;
            app.restart() // -> ! ; coerces to Result, no code after
        }
        None => Ok(json!({ "ok": true, "updateAvailable": false })),
    }
}

#[tauri::command]
async fn mai_agent_turn(
    state: tauri::State<'_, MaiServeState>,
    prompt: String,
) -> Result<Value, String> {
    uds_request(state.inner(), Method::POST, "/agent/turn", Some(json!({"prompt": prompt}))).await
}

#[tauri::command]
async fn mai_agent_abort(state: tauri::State<'_, MaiServeState>) -> Result<Value, String> {
    uds_request(state.inner(), Method::POST, "/agent/abort", Some(json!({}))).await
}

#[tauri::command]
async fn mai_agent_retry(state: tauri::State<'_, MaiServeState>) -> Result<Value, String> {
    uds_request(state.inner(), Method::POST, "/agent/retry", Some(json!({}))).await
}

#[tauri::command]
async fn mai_set_cron_mode(
    state: tauri::State<'_, MaiServeState>,
    enabled: bool,
) -> Result<Value, String> {
    uds_request(
        state.inner(),
        Method::POST,
        "/agent/cron-mode",
        Some(json!({"enabled": enabled})),
    )
    .await
}

// P-57g — passive auto-react toggle (mirrors mai_set_cron_mode).
#[tauri::command]
async fn mai_set_passive_mode(
    state: tauri::State<'_, MaiServeState>,
    enabled: bool,
) -> Result<Value, String> {
    uds_request(
        state.inner(),
        Method::POST,
        "/agent/passive-mode",
        Some(json!({"enabled": enabled})),
    )
    .await
}

#[tauri::command]
async fn mai_workflow_approve(
    state: tauri::State<'_, MaiServeState>,
    workflow_id: String,
    step_id: String,
) -> Result<Value, String> {
    uds_request(
        state.inner(),
        Method::POST,
        "/workflow/approve",
        Some(json!({"workflowId": workflow_id, "stepId": step_id})),
    )
    .await
}

#[tauri::command]
async fn mai_workflow_decline(
    state: tauri::State<'_, MaiServeState>,
    workflow_id: String,
    step_id: String,
    reason: Option<String>,
) -> Result<Value, String> {
    uds_request(
        state.inner(),
        Method::POST,
        "/workflow/decline",
        Some(json!({"workflowId": workflow_id, "stepId": step_id, "reason": reason})),
    )
    .await
}

#[tauri::command]
async fn mai_workflow_handoff(
    state: tauri::State<'_, MaiServeState>,
    workflow_id: String,
) -> Result<Value, String> {
    uds_request(
        state.inner(),
        Method::POST,
        "/workflow/handoff",
        Some(json!({"workflowId": workflow_id})),
    )
    .await
}

#[tauri::command]
async fn mai_workflow_cancel(
    state: tauri::State<'_, MaiServeState>,
    workflow_id: String,
) -> Result<Value, String> {
    uds_request(
        state.inner(),
        Method::POST,
        "/workflow/cancel",
        Some(json!({"workflowId": workflow_id})),
    )
    .await
}

/// P-56b SSE subscriber: reconnecting UDS stream reader forwarding data frames to the WebView.
async fn run_sse_subscriber(app: AppHandle, state: Arc<MaiServeState>) {
    loop {
        let client = Client::unix();
        let req = Request::builder()
            .method(Method::GET)
            .uri(build_uri(&state.sock_path, "/agent/events"))
            .header("Authorization", format!("Bearer {}", state.token))
            .header("Host", "localhost")
            .body(Body::empty());
        let req = match req {
            Ok(r) => r,
            Err(_) => {
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
        };
        let res = match client.request(req).await {
            Ok(r) => r,
            Err(_) => {
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
        };
        if res.status() != StatusCode::OK {
            tokio::time::sleep(Duration::from_secs(1)).await;
            continue;
        }

        let mut body = res.into_body();
        let mut buf = String::new();
        while let Some(chunk) = body.data().await {
            let bytes = match chunk {
                Ok(b) => b,
                Err(_) => break,
            };
            buf.push_str(&String::from_utf8_lossy(&bytes));
            while let Some(pos) = buf.find("\n\n") {
                let frame = buf[..pos].to_string();
                buf = buf[pos + 2..].to_string();
                if let Some(data) = frame.strip_prefix("data: ") {
                    if let Ok(val) = serde_json::from_str::<Value>(data.trim()) {
                        let _ = app.emit("overlay-event", val);
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

/// Generate a per-process UDS path under $TMPDIR and a 32-byte hex token.
fn provision_state() -> Result<(String, PathBuf, PathBuf), String> {
    let mut token_bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut token_bytes);
    let token = token_bytes
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<String>();

    let mut suffix = [0u8; 4];
    rand::thread_rng().fill_bytes(&mut suffix);
    let suffix_hex = suffix
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<String>();

    let tmp = std::env::temp_dir();
    let parent_dir = tmp.join(format!("mai-com.kyoube.mai-{}", suffix_hex));
    std::fs::create_dir(&parent_dir).map_err(|e| format!("mkdir {}: {}", parent_dir.display(), e))?;
    // Restrict parent dir to owner. The socket is also chmod'd by the Node sidecar.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&parent_dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("chmod 0700: {}", e))?;
    }
    let sock_path = parent_dir.join("mai.sock");
    Ok((token, sock_path, parent_dir))
}

/// [P-58d.3] Resource dir WITHOUT an AppHandle — resolve_* run before Tauri is built.
/// macOS: Contents/MacOS/mai-tauri -> Contents -> Contents/Resources.
fn bundled_resource_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.parent()?.parent()?.join("Resources").into()
}

/// Resolve an absolute `node` executable. A GUI-launched `.app` inherits launchd's
/// minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) — Homebrew node at
/// `/opt/homebrew/bin` is NOT on it — so a bare `Command::new("node")` fails from
/// Finder (BLOCKER-RISK #1). Probe an ordered candidate list; fall back to bare
/// "node" for the `cargo tauri dev` shell-PATH case.
fn resolve_node() -> String {
    if let Ok(p) = std::env::var("MAI_NODE_PATH") {
        let p = p.trim();
        if !p.is_empty() {
            if std::path::Path::new(p).is_file() {
                return p.to_string();
            }
            eprintln!("[mai-tauri] ignoring MAI_NODE_PATH={} (not a file)", p);
        }
    }
    if let Some(dir) = bundled_resource_dir() {
        let node = dir.join("runtime").join("node");
        if node.is_file() {
            return node.to_string_lossy().into_owned();
        }
    }
    for candidate in [
        "/opt/homebrew/bin/node", // Apple Silicon Homebrew
        "/usr/local/bin/node",    // Intel Homebrew
        "/usr/bin/node",          // system
    ] {
        if std::path::Path::new(candidate).is_file() {
            return candidate.to_string();
        }
    }
    "node".to_string() // dev fallback (shell PATH under `cargo tauri dev`)
}

/// Resolve the install.sh-installed `mai` CLI entry. install.sh symlinks the
/// npm-global package at `<brew-prefix>/lib/node_modules/@kyoube/mai-agent` →
/// `~/.mai/agent/releases/<tag>`; the runnable entry is `dist/cli/main.js` inside.
/// `MAI_BIN_PATH` overrides (dev / `cargo tauri dev`). Fall back to the dev
/// relative path so `cargo tauri dev` (CWD = src-tauri) keeps working.
/// NOTE: a fresh Mac with ONLY the `.app` (no prior install.sh) hits the dev
/// fallback, fails to resolve, and exits via the existing `await_serve_ready`
/// timeout — DEFERRED to P-58c (self-contained bundle).
fn resolve_mai_bin() -> String {
    if let Ok(p) = std::env::var("MAI_BIN_PATH") {
        let p = p.trim();
        if !p.is_empty() {
            if std::path::Path::new(p).is_file() {
                return p.to_string();
            }
            eprintln!("[mai-tauri] ignoring MAI_BIN_PATH={} (not a file)", p);
        }
    }
    if let Some(dir) = bundled_resource_dir() {
        let main_js = dir.join("runtime").join("dist").join("cli").join("main.js");
        if main_js.is_file() {
            return main_js.to_string_lossy().into_owned();
        }
    }
    for candidate in [
        "/opt/homebrew/lib/node_modules/@kyoube/mai-agent/dist/cli/main.js", // Apple Silicon
        "/usr/local/lib/node_modules/@kyoube/mai-agent/dist/cli/main.js",    // Intel
    ] {
        if std::path::Path::new(candidate).is_file() {
            return candidate.to_string();
        }
    }
    "../../../dist/cli/main.js".to_string() // dev fallback (cargo tauri dev)
}

/// P-58d.1: read the operator-set `updateServerUrl` directly from
/// ~/.mai/agent/config.json (independent of the sidecar; the updater runs
/// around it). None when absent/null/empty → the updater is a clean no-op.
/// Uses $HOME — no new crate dep (serde_json is already present).
fn read_update_server_url() -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let path = std::path::Path::new(&home).join(".mai/agent/config.json");
    let raw = std::fs::read_to_string(path).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let url = v.get("updateServerUrl")?.as_str()?.trim().to_string();
    if url.is_empty() {
        None
    } else {
        Some(url)
    }
}

/// P-58d.1: check the runtime-configured update endpoint once at launch
/// (OQ-58d.6: check-on-launch). Runs in a spawned task so a down/slow server
/// never blocks the UI. No URL → returns immediately. On a found update:
/// download → install → restart. All failures are logged + swallowed (a broken
/// updater must NOT crash the app).
async fn run_update_check(app: AppHandle) {
    let Some(url) = read_update_server_url() else {
        return;
    };
    let endpoint = format!("{}/latest.json", url.trim_end_matches('/'));
    let parsed = match endpoint.parse() {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[mai-tauri] invalid update endpoint {}: {}", endpoint, e);
            return;
        }
    };
    let updater = match app
        .updater_builder()
        .endpoints(vec![parsed])
        .and_then(|b| b.build())
    {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[mai-tauri] updater init failed: {}", e);
            return;
        }
    };
    match updater.check().await {
        Ok(Some(update)) => {
            eprintln!("[mai-tauri] update available: {}", update.version);
            if let Err(e) = update
                .download_and_install(|_chunk, _total| {}, || {})
                .await
            {
                eprintln!("[mai-tauri] update install failed: {}", e);
                return;
            }
            app.restart();
        }
        Ok(None) => eprintln!("[mai-tauri] no update available"),
        Err(e) => eprintln!("[mai-tauri] update check failed: {}", e),
    }
}

/// Spawn `node <mai_bin> serve --sock <path> --token <tok>` as a child process.
async fn spawn_mai_serve(sock: &PathBuf, token: &str) -> Result<Child, String> {
    // P-58b: resolve node + the install.sh-installed CLI by absolute path so a
    // Finder-launched bundle (launchd minimal PATH) can spawn the sidecar.
    let mai_bin = PathBuf::from(resolve_mai_bin());
    let node_path = PathBuf::from(resolve_node());
    eprintln!(
        "[mai-tauri] node={} mai={}",
        node_path.display(),
        mai_bin.display()
    );
    let child = Command::new(&node_path)
        .arg(&mai_bin)
        .arg("serve")
        .arg("--sock")
        .arg(sock.to_str().ok_or("invalid sock path utf-8")?)
        .arg("--token")
        .arg(token)
        .env("MAI_AUTOUPDATE", "skip")
        .env("MAI_SIDECAR_OWNER", "frondose-app")
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .map_err(|e| format!("spawn mai serve: {}", e))?;
    Ok(child)
}

/// Block until the UDS sock file appears + a GET /health returns ok, or timeout.
async fn await_serve_ready(state: &MaiServeState, timeout_ms: u64) -> Result<(), String> {
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    while std::time::Instant::now() < deadline {
        if state.sock_path.exists() && uds_request(state, Method::GET, "/health", None).await.is_ok() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(format!("mai serve not ready within {}ms", timeout_ms))
}

/// Tear down sidecar process + clean up UDS dir.
async fn shutdown_sidecar(state: &MaiServeState) {
    let mut child_guard = state.child.lock().await;
    if let Some(mut child) = child_guard.take() {
        if let Some(pid) = child.id() {
            #[cfg(unix)]
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
        }
        let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
        let _ = child.kill().await;
    }
    let _ = std::fs::remove_dir_all(&state.parent_dir);
}

#[tokio::main]
async fn main() {
    let (token, sock_path, parent_dir) = provision_state().expect("provision UDS state");
    // P-58d.1 [3b/CMR-2]: best-effort spawn — a missing/broken sidecar must NOT panic
    // before the updater gets a turn (the updater is the recovery path).
    let child = spawn_mai_serve(&sock_path, &token).await.ok();

    let state = Arc::new(MaiServeState {
        token,
        sock_path: sock_path.clone(),
        parent_dir: parent_dir.clone(),
        child: Arc::new(Mutex::new(child)),
    });
    let state_clone = state.clone();

    let app = tauri::Builder::default()
        .manage(MaiServeState {
            token: state.token.clone(),
            sock_path: state.sock_path.clone(),
            parent_dir: state.parent_dir.clone(),
            child: state.child.clone(),
        })
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            mai_health,
            mai_identity,
            mai_get_settings,
            mai_set_settings,
            mai_chrome_ensure,
            mai_agent_turn,
            mai_agent_abort,
            mai_agent_retry,
            mai_set_cron_mode,
            mai_set_passive_mode,
            mai_workflow_approve,
            mai_workflow_decline,
            mai_workflow_handoff,
            mai_workflow_cancel,
            mai_check_update
        ])
        .build(tauri::generate_context!())
        .expect("Tauri build");

    let app_handle = app.handle().clone();

    // P-58d.1 [3b/CMR-2 + 3b-r2/CONCERN-MR]: spawn the updater task BEFORE the
    // sidecar-readiness gate so it runs INDEPENDENT of sidecar health — a sidecar-breaking
    // SHELL release can self-recover. (Thin-launcher .1 swaps the shell only; full
    // agent-sidecar recovery is .3. .1 guarantees the check always RUNS.) The task PARKS on
    // `ready_notify.notified()` until the RunEvent::Ready arm of app.run() fires, so
    // check()/download_and_install()/restart() can only execute once the event loop is live
    // and the app.run shutdown handlers are registered — closing the pre-app.run() restart
    // race (a pre-run restart would BYPASS those handlers).
    let ready_notify = Arc::new(Notify::new());
    let app_handle_updater = app_handle.clone();
    let updater_ready = ready_notify.clone();
    tokio::spawn(async move {
        updater_ready.notified().await; // park until the run loop signals Ready
        run_update_check(app_handle_updater).await;
    });

    // P-56b: SSE subscriber (reconnecting — tolerates a not-yet-ready sidecar).
    let app_handle_sse = app_handle.clone();
    let state_for_sse = state.clone();
    tokio::spawn(async move {
        run_sse_subscriber(app_handle_sse, state_for_sse).await;
    });

    // SIGTERM handler.
    let app_handle_sigterm = app_handle.clone();
    tokio::spawn(async move {
        use tokio::signal::unix::{signal, SignalKind};
        match signal(SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
                app_handle_sigterm.exit(0);
            }
            Err(e) => eprintln!("[mai-tauri] SIGTERM handler init failed: {}", e),
        }
    });

    // P-58d.1 [3b/CMR-2]: sidecar readiness is now NON-FATAL (was std::process::exit(1)).
    // Same 10s budget → happy path unchanged (window appears once the sidecar is healthy);
    // on failure we LOG + proceed to a degraded window so the updater (spawned above) can
    // recover a bad release instead of the app silently exiting.
    if let Err(e) = await_serve_ready(&state, 10_000).await {
        eprintln!(
            "[mai-tauri] mai serve not ready: {} — UI degraded; updater may recover a bad release",
            e
        );
    }

    app.run(move |app_handle, event| {
        match event {
            // P-58d.1 [3b-r2/CONCERN-MR]: the event loop is live — release the parked
            // updater task. notify_one() stores a permit, so this is race-free even if the
            // task has not yet reached notified().await when Ready fires.
            RunEvent::Ready => {
                ready_notify.notify_one();
            }
            // D-RUN-1 (safety): macOS does NOT auto-exit when the last window closes
            // (NSApplication convention), so RunEvent::ExitRequested never fires on a
            // window-close — the spawned `mai serve` sidecar (+ agent loop + Chrome
            // control) would survive and keep driving the browser. Kill the sidecar and
            // force the app to exit so app-close reliably stops the agent.
            RunEvent::WindowEvent {
                event: WindowEvent::CloseRequested { .. },
                ..
            } => {
                let state_for_shutdown = state_clone.clone();
                tokio::task::block_in_place(|| {
                    tokio::runtime::Handle::current().block_on(async {
                        shutdown_sidecar(&state_for_shutdown).await;
                    })
                });
                app_handle.exit(0);
            }
            // Cmd+Q / programmatic exit (incl. our SIGTERM handler). shutdown_sidecar is
            // idempotent (child handle is take()n once) so double-invocation is safe.
            RunEvent::ExitRequested { .. } => {
                let state_for_shutdown = state_clone.clone();
                tokio::task::block_in_place(|| {
                    tokio::runtime::Handle::current().block_on(async {
                        shutdown_sidecar(&state_for_shutdown).await;
                    })
                });
            }
            _ => {}
        }
    });
}

// libc for signals - declared as a direct dep in Cargo.toml (rev-1 Step 3b NIT-N1 fix).
// On macOS, `libc::SIGTERM` + `libc::kill` are used to gracefully signal the sidecar.
