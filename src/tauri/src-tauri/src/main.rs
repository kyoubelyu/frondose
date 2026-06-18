// P-56a M-1 SCAFFOLD: Tauri shell for the v0.5 hover pivot. Throwaway-scope -
// the entire file may be restructured in P-56b/M-2/M-3. Approved-site for
// child_process via tokio::process::Command (see CLAUDE.md HR-8).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use hyper::body::HttpBody;
use hyper::{Body, Client, Method, Request, StatusCode, Uri};
use rand::RngCore;
use serde_json::{json, Value};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_updater::UpdaterExt;
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, Notify};

/// Per-app state: bearer token + UDS path + sidecar child handle.
///
/// [P-75 D-24] `shutting_down` + `child_pid` added to support the sidecar-watchdog
/// supervisor task. The supervisor owns the Child during `.wait()` (which removes it
/// from the mutex), so `shutdown_sidecar` cannot reach it via the mutex. It instead
/// reads the current sidecar PID from `child_pid` and `libc::kill`s it directly;
/// the supervisor observes `shutting_down=true` after the wait returns and exits
/// without respawning. Both fields are atomics so all Arc-clones share them
/// (Tauri's `manage()` copies the Arc handles via `.clone()`, not the inner data).
struct FrondoseServeState {
    token: String,
    /// WIN-1: the sidecar's current loopback TCP port (0 = not ready). Shared
    /// Arc<AtomicU16> across all state clones so a supervised respawn (which gets a
    /// NEW ephemeral port) is visible to every request + the SSE subscriber.
    port: Arc<AtomicU16>,
    /// WIN-1: path the sidecar writes its chosen port to; Rust polls it on boot + respawn.
    port_file: PathBuf,
    parent_dir: PathBuf,
    child: Arc<Mutex<Option<Child>>>,
    shutting_down: Arc<AtomicBool>,
    child_pid: Arc<AtomicU32>,
}

/// Build a loopback HTTP URI for the sidecar's current port. Paths are static literals.
fn build_uri(port: u16, path: &str) -> Uri {
    format!("http://127.0.0.1:{}{}", port, path)
        .parse()
        .expect("static loopback uri")
}

/// One-shot loopback-TCP HTTP request (no keepalive). Returns response body as Value.
async fn uds_request(
    state: &FrondoseServeState,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let port = state.port.load(Ordering::SeqCst);
    if port == 0 {
        return Err("sidecar not ready (no port)".to_string());
    }
    let client = Client::new();
    let mut req = Request::builder()
        .method(method)
        .uri(build_uri(port, path))
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
        serde_json::from_slice(&buf).map_err(|e| format!("invalid JSON from frondose serve: {}", e))?;
    if status != StatusCode::OK {
        return Err(format!("HTTP {}: {}", status, parsed));
    }
    Ok(parsed)
}

#[tauri::command]
async fn frondose_health(state: tauri::State<'_, FrondoseServeState>) -> Result<Value, String> {
    uds_request(state.inner(), Method::GET, "/health", None).await
}

#[tauri::command]
async fn frondose_identity(state: tauri::State<'_, FrondoseServeState>) -> Result<Value, String> {
    uds_request(state.inner(), Method::GET, "/identity", None).await
}

#[tauri::command]
async fn frondose_chrome_ensure(state: tauri::State<'_, FrondoseServeState>) -> Result<Value, String> {
    uds_request(state.inner(), Method::POST, "/chrome/ensure", Some(json!({}))).await
}

// P-Y6 — in-app settings (auth/identity/soul). Mirror frondose_identity → GET /settings;
// frondose_set_settings POSTs the masked-safe patch. The serve handler returns a masked view.
#[tauri::command]
async fn frondose_get_settings(state: tauri::State<'_, FrondoseServeState>) -> Result<Value, String> {
    uds_request(state.inner(), Method::GET, "/settings", None).await
}

#[tauri::command]
async fn frondose_set_settings(
    state: tauri::State<'_, FrondoseServeState>,
    settings: Value,
) -> Result<Value, String> {
    uds_request(state.inner(), Method::POST, "/settings", Some(settings)).await
}

// P-58d.1 — manual "Check for updates" trigger (OQ-58d.6). Custom command (no
// plugin command exposed to JS → no capability change). The Settings-panel
// button that calls this ships in P-58d.1-UI.
#[tauri::command]
async fn frondose_check_update(app: tauri::AppHandle) -> Result<Value, String> {
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
async fn frondose_agent_turn(
    state: tauri::State<'_, FrondoseServeState>,
    prompt: String,
) -> Result<Value, String> {
    uds_request(state.inner(), Method::POST, "/agent/turn", Some(json!({"prompt": prompt}))).await
}

#[tauri::command]
async fn frondose_agent_abort(state: tauri::State<'_, FrondoseServeState>) -> Result<Value, String> {
    uds_request(state.inner(), Method::POST, "/agent/abort", Some(json!({}))).await
}

#[tauri::command]
async fn frondose_agent_retry(state: tauri::State<'_, FrondoseServeState>) -> Result<Value, String> {
    uds_request(state.inner(), Method::POST, "/agent/retry", Some(json!({}))).await
}

#[tauri::command]
async fn frondose_set_cron_mode(
    state: tauri::State<'_, FrondoseServeState>,
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

// P-57g — passive auto-react toggle (mirrors frondose_set_cron_mode).
#[tauri::command]
async fn frondose_set_passive_mode(
    state: tauri::State<'_, FrondoseServeState>,
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
async fn frondose_workflow_approve(
    state: tauri::State<'_, FrondoseServeState>,
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
async fn frondose_workflow_decline(
    state: tauri::State<'_, FrondoseServeState>,
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
async fn frondose_workflow_handoff(
    state: tauri::State<'_, FrondoseServeState>,
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
async fn frondose_workflow_cancel(
    state: tauri::State<'_, FrondoseServeState>,
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
async fn run_sse_subscriber(app: AppHandle, state: Arc<FrondoseServeState>) {
    loop {
        let port = state.port.load(Ordering::SeqCst);
        if port == 0 {
            // Sidecar not ready (boot or mid-respawn) — wait for a port to be published.
            tokio::time::sleep(Duration::from_millis(200)).await;
            continue;
        }
        let client = Client::new();
        let req = Request::builder()
            .method(Method::GET)
            .uri(build_uri(port, "/agent/events"))
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

/// WIN-1: generate a per-process port-file path under $TMPDIR and a 32-byte hex token.
/// The sidecar binds 127.0.0.1:0 and writes the chosen port to the port-file; the bearer
/// token (not the dir perms) is the request guard, so no chmod is needed (cross-platform).
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
    let parent_dir = tmp.join(format!("frondose-com.kyoube.frondose-{}", suffix_hex));
    std::fs::create_dir(&parent_dir).map_err(|e| format!("mkdir {}: {}", parent_dir.display(), e))?;
    let port_file = parent_dir.join("frondose.port");
    Ok((token, port_file, parent_dir))
}

/// [P-58d.3] Resource dir WITHOUT an AppHandle — resolve_* run before Tauri is built.
/// macOS: Contents/MacOS/Frondose -> Contents -> Contents/Resources.
/// Windows: Frondose.exe sits beside bundled runtime/.
fn bundled_resource_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    if cfg!(windows) {
        exe.parent().map(PathBuf::from)
    } else {
        exe.parent()?.parent()?.join("Resources").into()
    }
}

#[cfg(windows)]
fn windows_sidecar_log_path() -> Option<PathBuf> {
    let profile = std::env::var("USERPROFILE").ok()?;
    if profile.trim().is_empty() {
        return None;
    }
    let dir = std::path::Path::new(&profile)
        .join(".frondose")
        .join("agent")
        .join("logs");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("[frondose] sidecar log mkdir failed: {}", e);
        return None;
    }
    Some(dir.join("sidecar.log"))
}

/// Resolve an absolute `node` executable. A GUI-launched `.app` inherits launchd's
/// minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) — Homebrew node at
/// `/opt/homebrew/bin` is NOT on it — so a bare `Command::new("node")` fails from
/// Finder (BLOCKER-RISK #1). Probe an ordered candidate list; fall back to bare
/// "node" for the `cargo tauri dev` shell-PATH case.
fn resolve_node() -> String {
    if let Ok(p) = std::env::var("FRONDOSE_NODE_PATH") {
        let p = p.trim();
        if !p.is_empty() {
            if std::path::Path::new(p).is_file() {
                return p.to_string();
            }
            eprintln!(
                "[frondose] ignoring FRONDOSE_NODE_PATH={} (not a file)",
                p
            );
        }
    }
    if let Some(dir) = bundled_resource_dir() {
        let runtime = dir.join("runtime");
        if cfg!(windows) {
            let node_exe = runtime.join("node.exe");
            if node_exe.is_file() {
                return node_exe.to_string_lossy().into_owned();
            }
        }
        let node = runtime.join("node");
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

/// [P-APP-6] Resolve the app sidecar entrypoint (dist/app/sidecarMain.js).
/// Replaces the CLI-routed sidecar boot. FRONDOSE_SIDECAR_BIN_PATH overrides
/// (dev / sibling installs). Bundled path is the .app's
/// Contents/Resources/runtime/dist/app/sidecarMain.js. CLI `serve` stays in
/// parallel during P-APP-11 migration; it is not the spawn target.
fn resolve_sidecar_bin() -> String {
    if let Ok(p) = std::env::var("FRONDOSE_SIDECAR_BIN_PATH") {
        let p = p.trim();
        if !p.is_empty() {
            if std::path::Path::new(p).is_file() {
                return p.to_string();
            }
            eprintln!(
                "[frondose] ignoring FRONDOSE_SIDECAR_BIN_PATH={} (not a file)",
                p
            );
        }
    }
    if let Some(dir) = bundled_resource_dir() {
        let entry = dir.join("runtime").join("dist").join("app").join("sidecarMain.js");
        if entry.is_file() {
            return entry.to_string_lossy().into_owned();
        }
    }
    for candidate in [
        "/opt/homebrew/lib/node_modules/@kyoube/frondose/dist/app/sidecarMain.js",
        "/usr/local/lib/node_modules/@kyoube/frondose/dist/app/sidecarMain.js",
    ] {
        if std::path::Path::new(candidate).is_file() {
            return candidate.to_string();
        }
    }
    "../../../dist/app/sidecarMain.js".to_string() // dev fallback (cargo tauri dev)
}

/// Resolve the install.sh-installed `mai` CLI entry. install.sh symlinks the
/// npm-global package at `<brew-prefix>/lib/node_modules/@kyoube/frondose` →
/// `~/.frondose/agent/releases/<tag>`; the runnable entry is `dist/cli/main.js` inside.
/// `FRONDOSE_BIN_PATH` overrides (dev / `cargo tauri dev`). Fall back to the dev
/// relative path so `cargo tauri dev` (CWD = src-tauri) keeps working.
/// NOTE: a fresh Mac with ONLY the `.app` (no prior install.sh) hits the dev
/// fallback, fails to resolve, and exits via the existing `await_serve_ready`
/// timeout — DEFERRED to P-58c (self-contained bundle).
// Kept for the P-APP-11 transition; delete with the CLI entrypoint.
#[allow(dead_code)]
fn resolve_frondose_bin() -> String {
    if let Ok(p) = std::env::var("FRONDOSE_BIN_PATH") {
        let p = p.trim();
        if !p.is_empty() {
            if std::path::Path::new(p).is_file() {
                return p.to_string();
            }
            eprintln!(
                "[frondose] ignoring FRONDOSE_BIN_PATH={} (not a file)",
                p
            );
        }
    }
    if let Some(dir) = bundled_resource_dir() {
        let main_js = dir.join("runtime").join("dist").join("cli").join("main.js");
        if main_js.is_file() {
            return main_js.to_string_lossy().into_owned();
        }
    }
    for candidate in [
        "/opt/homebrew/lib/node_modules/@kyoube/frondose/dist/cli/main.js", // Apple Silicon
        "/usr/local/lib/node_modules/@kyoube/frondose/dist/cli/main.js",    // Intel
    ] {
        if std::path::Path::new(candidate).is_file() {
            return candidate.to_string();
        }
    }
    "../../../dist/cli/main.js".to_string() // dev fallback (cargo tauri dev)
}

/// P-58d.1: read the operator-set `updateServerUrl` directly from
/// ~/.frondose/agent/config.json (independent of the sidecar; the updater runs
/// around it). Falls back to ~/.mai/agent/config.json for the first-launch window
/// where Tauri boots before the sidecar migrates the data dir. None when
/// absent/null/empty → the updater is a clean no-op. Uses $HOME — no new crate dep
/// (serde_json is already present).
fn read_update_server_url() -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let new_path = std::path::Path::new(&home).join(".frondose/agent/config.json");
    let raw = std::fs::read_to_string(&new_path)
        .or_else(|_| {
            let legacy = std::path::Path::new(&home).join(".mai/agent/config.json");
            std::fs::read_to_string(legacy)
        })
        .ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let url = v.get("updateServerUrl")?.as_str()?.trim().to_string();
    if url.is_empty() {
        None
    } else {
        Some(url)
    }
}

/// P-58d.3 — Periodic update-check interval in seconds. Reads
/// `updateCheckIntervalSec` from ~/.frondose/agent/config.json, with the same
/// first-launch fallback to ~/.mai/agent/config.json. Defaults to 3600 (1 hour)
/// — early-release operator directive 2026-06-09: "发布初期会经常更新".
/// Floor of 60s (sanity guard against a config typo that hammers the server).
/// Returning 0 disables periodic polling (operator opt-out without removing
/// updateServerUrl).
fn read_update_check_interval_sec() -> u64 {
    let default_sec: u64 = 3600;
    let Some(home) = std::env::var("HOME").ok() else {
        return default_sec;
    };
    let new_path = std::path::Path::new(&home).join(".frondose/agent/config.json");
    let Ok(raw) = std::fs::read_to_string(&new_path).or_else(|_| {
        let legacy = std::path::Path::new(&home).join(".mai/agent/config.json");
        std::fs::read_to_string(legacy)
    }) else {
        return default_sec;
    };
    let Ok(v) = serde_json::from_str::<Value>(&raw) else {
        return default_sec;
    };
    match v.get("updateCheckIntervalSec").and_then(|x| x.as_u64()) {
        Some(0) => 0, // operator-set 0 → disable periodic polling
        Some(n) if n < 60 => 60,
        Some(n) => n,
        None => default_sec,
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
            eprintln!("[frondose] invalid update endpoint {}: {}", endpoint, e);
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
            eprintln!("[frondose] updater init failed: {}", e);
            return;
        }
    };
    match updater.check().await {
        Ok(Some(update)) => {
            eprintln!("[frondose] update available: {}", update.version);
            if let Err(e) = update
                .download_and_install(|_chunk, _total| {}, || {})
                .await
            {
                eprintln!("[frondose] update install failed: {}", e);
                return;
            }
            app.restart();
        }
        Ok(None) => eprintln!("[frondose] no update available"),
        Err(e) => eprintln!("[frondose] update check failed: {}", e),
    }
}

/// Spawn `node <sidecar_bin> --port-file <path> --token <tok>` as a child process.
async fn spawn_frondose_serve(port_file: &PathBuf, token: &str) -> Result<Child, String> {
    // P-APP-6: resolve node + the dedicated app sidecar entrypoint by absolute
    // path so a Finder-launched bundle (launchd minimal PATH) can spawn it.
    let sidecar_bin = PathBuf::from(resolve_sidecar_bin());
    let node_path = PathBuf::from(resolve_node());
    eprintln!(
        "[frondose] node={} sidecar={}",
        node_path.display(),
        sidecar_bin.display()
    );
    let mut command = Command::new(&node_path);
    command
        .arg(&sidecar_bin)
        .arg("--port-file")
        .arg(port_file.to_str().ok_or("invalid port-file path utf-8")?)
        .arg("--token")
        .arg(token)
        .env("FRONDOSE_AUTOUPDATE", "skip")
        .env("FRONDOSE_SIDECAR_OWNER", "frondose-app")
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit());
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        let redirected = (|| -> std::io::Result<()> {
            let path = windows_sidecar_log_path()
                .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "no log path"))?;
            let out_file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)?;
            let err_file = out_file.try_clone()?;
            command.stdout(std::process::Stdio::from(out_file));
            command.stderr(std::process::Stdio::from(err_file));
            Ok(())
        })();
        if let Err(e) = redirected {
            eprintln!(
                "[frondose] sidecar log redirect failed: {} — falling back to null",
                e
            );
            command.stdout(std::process::Stdio::null());
            command.stderr(std::process::Stdio::null());
        }
    }
    let child = command
        .spawn()
        .map_err(|e| format!("spawn mai sidecar: {}", e))?;
    Ok(child)
}

/// WIN-1: block until the sidecar's port-file appears + parses to a non-zero port + a
/// GET /health on that port returns ok; on success store the port into `state.port`
/// (so requests/SSE target it) and return. Used at boot AND after every supervised
/// respawn (each respawn binds a NEW ephemeral port).
async fn await_serve_ready(state: &FrondoseServeState, timeout_ms: u64) -> Result<(), String> {
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    while std::time::Instant::now() < deadline {
        if let Ok(s) = std::fs::read_to_string(&state.port_file) {
            if let Ok(port) = s.trim().parse::<u16>() {
                if port != 0 {
                    // Publish the port BEFORE the health check so uds_request targets it.
                    state.port.store(port, Ordering::SeqCst);
                    if uds_request(state, Method::GET, "/health", None).await.is_ok() {
                        return Ok(());
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    state.port.store(0, Ordering::SeqCst);
    Err(format!("frondose serve not ready within {}ms", timeout_ms))
}

/// Tear down sidecar process + clean up UDS dir.
///
/// [P-75 D-24] Refactored to coexist with `supervise_sidecar`. The supervisor owns
/// the Child during `child.wait()` (the mutex is empty for the lifetime of a wait),
/// so this function must NOT take from `state.child` — it instead sets the
/// `shutting_down` flag (read by the supervisor on wait-return) and SIGTERM/SIGKILLs
/// by PID directly via `state.child_pid`. The supervisor then sees the flag and
/// returns without respawning. UDS dir cleanup runs unconditionally.
async fn shutdown_sidecar(state: &FrondoseServeState) {
    // Mark shutdown FIRST so any pending respawn iteration sees it.
    state.shutting_down.store(true, Ordering::SeqCst);

    let pid = state.child_pid.load(Ordering::SeqCst);
    if pid > 0 {
        #[cfg(unix)]
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
        #[cfg(windows)]
        {
            // Windows has no SIGTERM — graceful tree-terminate by PID (WIN-3).
            let _ = tokio::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T"])
                .output()
                .await;
        }
        // Brief wait for graceful exit; force-kill if still alive.
        tokio::time::sleep(Duration::from_millis(800)).await;
        let still_alive = state.child_pid.load(Ordering::SeqCst) > 0;
        if still_alive {
            #[cfg(unix)]
            unsafe {
                libc::kill(pid as i32, libc::SIGKILL);
            }
            #[cfg(windows)]
            {
                let _ = tokio::process::Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .output()
                    .await;
            }
        }
    }
    let _ = std::fs::remove_dir_all(&state.parent_dir);
}

/// [P-75 D-24] Sidecar supervision watchdog. Owns the Child between spawn+wait,
/// detects unexpected exit (kill -9, crash, panic), and respawns with bounded
/// exponential backoff. Pre-D-24 the Tauri host did NOT supervise the sidecar:
/// a `kill -9 <sidecar PID>` left the host process alive but unable to serve
/// any /agent/turn (the UDS responded with nothing); only a Frondose relaunch
/// restored a working agent. Now: dead sidecar → 500ms backoff → respawn at
/// the SAME sock path + same auth token, so the UI keeps working transparently.
///
/// Bounds:
///   - Initial backoff: 500ms.
///   - Backoff doubles on each consecutive respawn failure, capped at 30s.
///   - After 8 consecutive respawn-spawn failures (NOT respawn-wait deaths),
///     the supervisor gives up and exits. The user sees a degraded UI; the
///     updater task may still recover a bad release.
///   - When `shutting_down` is set, the supervisor returns immediately (after
///     any in-flight `child.wait()` resolves), without attempting to respawn.
///
/// Race protection: `shutdown_sidecar` does NOT take from `state.child`; the
/// supervisor is the sole owner of the Child during its lifetime. Shutdown
/// signals via SIGTERM-by-PID + the `shutting_down` flag.
async fn supervise_sidecar(state: Arc<FrondoseServeState>) {
    const INITIAL_BACKOFF_MS: u64 = 500;
    const MAX_BACKOFF_MS: u64 = 30_000;
    const MAX_CONSECUTIVE_SPAWN_FAILURES: u32 = 8;
    let mut backoff_ms = INITIAL_BACKOFF_MS;
    let mut consecutive_spawn_failures: u32 = 0;

    loop {
        if state.shutting_down.load(Ordering::SeqCst) {
            eprintln!("[frondose] D-24 supervisor: shutdown flag set, exiting");
            return;
        }

        // Take ownership of the current Child. May be None on initial spawn failure
        // or if a prior respawn iteration hasn't completed yet — fall through to
        // the spawn block below.
        let taken = { state.child.lock().await.take() };

        if let Some(mut child) = taken {
            let pid = child.id().unwrap_or(0);
            state.child_pid.store(pid, Ordering::SeqCst);
            eprintln!("[frondose] D-24 supervisor: watching sidecar pid={}", pid);

            let exit = child.wait().await;
            state.child_pid.store(0, Ordering::SeqCst);

            if state.shutting_down.load(Ordering::SeqCst) {
                eprintln!(
                    "[frondose] D-24 supervisor: child exited during shutdown (pid={}) — done",
                    pid
                );
                return;
            }
            eprintln!(
                "[frondose] D-24 sidecar (pid={}) died UNEXPECTEDLY: {:?} — respawning",
                pid, exit
            );
            consecutive_spawn_failures = 0;
            backoff_ms = INITIAL_BACKOFF_MS;
        } else {
            eprintln!("[frondose] D-24 supervisor: no child to wait on; attempting (re)spawn");
        }

        tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
        if state.shutting_down.load(Ordering::SeqCst) {
            return;
        }

        // [WIN-1] Mark the port not-ready and remove the dead sidecar's stale port-file
        // BEFORE respawn. The respawned sidecar binds a NEW ephemeral 127.0.0.1 port and
        // writes it to a FRESH port-file; clearing the cached port (0) + deleting the stale
        // file closes the stale-read hole (Rust would otherwise read the dead port and
        // health-check a dead address). `remove_file` is best-effort.
        state.port.store(0, Ordering::SeqCst);
        let _ = std::fs::remove_file(&state.port_file);

        match spawn_frondose_serve(&state.port_file, &state.token).await {
            Ok(new_child) => {
                let new_pid = new_child.id().unwrap_or(0);
                state.child_pid.store(new_pid, Ordering::SeqCst);
                eprintln!("[frondose] D-24 sidecar respawned: pid={}", new_pid);
                // [WIN-1] Wait for the new sidecar to publish its port-file + pass /health,
                // then `await_serve_ready` stores the NEW port so requests/SSE target it.
                if let Err(e) = await_serve_ready(&state, 10_000).await {
                    eprintln!("[frondose] WIN-1 respawn: sidecar port not ready: {}", e);
                }
                {
                    let mut g = state.child.lock().await;
                    *g = Some(new_child);
                }
                consecutive_spawn_failures = 0;
                backoff_ms = INITIAL_BACKOFF_MS;
            }
            Err(e) => {
                consecutive_spawn_failures += 1;
                eprintln!(
                    "[frondose] D-24 respawn failed (#{}): {} — retry after {}ms",
                    consecutive_spawn_failures, e, backoff_ms
                );
                if consecutive_spawn_failures >= MAX_CONSECUTIVE_SPAWN_FAILURES {
                    eprintln!(
                        "[frondose] D-24 supervisor: giving up after {} consecutive respawn failures",
                        MAX_CONSECUTIVE_SPAWN_FAILURES
                    );
                    return;
                }
                backoff_ms = (backoff_ms * 2).min(MAX_BACKOFF_MS);
            }
        }
    }
}

#[tokio::main]
async fn main() {
    let (token, port_file, parent_dir) = provision_state().expect("provision sidecar state");
    // P-58d.1 [3b/CMR-2]: best-effort spawn — a missing/broken sidecar must NOT panic
    // before the updater gets a turn (the updater is the recovery path).
    let child = spawn_frondose_serve(&port_file, &token).await.ok();

    // [P-75 D-24] Atomics for the watchdog: shared by the outer `state` Arc AND the
    // Tauri-managed state (via Arc::clone in `manage()` below). The supervisor reads/
    // writes `child_pid` around `child.wait()`; `shutdown_sidecar` reads it to send
    // SIGTERM. `shutting_down` is the supervisor's exit signal.
    // [WIN-1] `port` (0 = not ready) is shared the same way so a respawn's new ephemeral
    // port reaches every request + the SSE subscriber.
    let shutting_down = Arc::new(AtomicBool::new(false));
    let child_pid = Arc::new(AtomicU32::new(child.as_ref().and_then(|c| c.id()).unwrap_or(0)));
    let port = Arc::new(AtomicU16::new(0));

    let state = Arc::new(FrondoseServeState {
        token,
        port: port.clone(),
        port_file: port_file.clone(),
        parent_dir: parent_dir.clone(),
        child: Arc::new(Mutex::new(child)),
        shutting_down: shutting_down.clone(),
        child_pid: child_pid.clone(),
    });
    let state_clone = state.clone();

    // [P-75 D-24] Spawn the sidecar supervision watchdog. Must run for the lifetime
    // of the Tauri host process so any sidecar death (kill -9, crash) is observed
    // and recovered. The watchdog OWNS the Child during wait() — see
    // `supervise_sidecar` for the race contract with `shutdown_sidecar`.
    {
        let state_for_supervisor = state.clone();
        tokio::spawn(async move {
            supervise_sidecar(state_for_supervisor).await;
        });
    }

    let app = tauri::Builder::default()
        .manage(FrondoseServeState {
            token: state.token.clone(),
            port: state.port.clone(),
            port_file: state.port_file.clone(),
            parent_dir: state.parent_dir.clone(),
            child: state.child.clone(),
            shutting_down: state.shutting_down.clone(),
            child_pid: state.child_pid.clone(),
        })
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            frondose_health,
            frondose_identity,
            frondose_get_settings,
            frondose_set_settings,
            frondose_chrome_ensure,
            frondose_agent_turn,
            frondose_agent_abort,
            frondose_agent_retry,
            frondose_set_cron_mode,
            frondose_set_passive_mode,
            frondose_workflow_approve,
            frondose_workflow_decline,
            frondose_workflow_handoff,
            frondose_workflow_cancel,
            frondose_check_update
        ])
        .build(tauri::generate_context!())
        .expect("Tauri build");

    let app_handle = app.handle().clone();

    let _tray = {
        let show = MenuItemBuilder::with_id("show", "Show Frondose")
            .build(&app)
            .expect("menu show");
        let quit = MenuItemBuilder::with_id("quit", "Quit Frondose")
            .build(&app)
            .expect("menu quit");
        let menu = MenuBuilder::new(&app)
            .items(&[&show, &quit])
            .build()
            .expect("tray menu");
        TrayIconBuilder::new()
            .icon(app.default_window_icon().cloned().expect("window icon"))
            .tooltip("Frondose — running in the menu bar")
            .menu(&menu)
            .on_menu_event(|app, event| match event.id().as_ref() {
                "show" => {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
                "quit" => {
                    let state = app.state::<FrondoseServeState>();
                    tokio::task::block_in_place(|| {
                        tokio::runtime::Handle::current().block_on(async {
                            shutdown_sidecar(&state).await;
                        })
                    });
                    app.exit(0);
                }
                _ => {}
            })
            .build(&app)
            .expect("tray build")
    };

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

    // P-58d.3 — Periodic update-check task (operator directive 2026-06-09:
    // "发布初期会经常更新"). After the boot-time check above, poll at
    // updateCheckIntervalSec (default 3600s = 1h, floor 60s, 0 = disabled).
    // First periodic tick fires AFTER one interval (so it doesn't double-check
    // back-to-back with the boot check). Runs forever; checks are
    // best-effort (run_update_check swallows all errors). Returns immediately
    // when no updateServerUrl is configured — same no-op contract as the boot
    // check, so a typo'd config never wastes cycles.
    let app_handle_periodic = app_handle.clone();
    let periodic_ready = ready_notify.clone();
    tokio::spawn(async move {
        periodic_ready.notified().await; // park alongside the boot check
        let interval_sec = read_update_check_interval_sec();
        if interval_sec == 0 {
            return; // operator opt-out
        }
        let mut ticker = tokio::time::interval(Duration::from_secs(interval_sec));
        ticker.tick().await; // first tick fires immediately — discard so we don't double-check
        loop {
            ticker.tick().await;
            // Re-read updateServerUrl on every tick so toggling config.json
            // updateServerUrl=null is honored without an app restart.
            if read_update_server_url().is_some() {
                run_update_check(app_handle_periodic.clone()).await;
            }
        }
    });

    // P-56b: SSE subscriber (reconnecting — tolerates a not-yet-ready sidecar).
    let app_handle_sse = app_handle.clone();
    let state_for_sse = state.clone();
    tokio::spawn(async move {
        run_sse_subscriber(app_handle_sse, state_for_sse).await;
    });

    // Graceful-quit signal handler. Unix: SIGTERM. Windows: Ctrl+C / console-close
    // (Windows has no SIGTERM) — cfg-split so the unix-only `tokio::signal::unix`
    // import does not leak into the windows-msvc build (WIN-3).
    let app_handle_sigterm = app_handle.clone();
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{signal, SignalKind};
            match signal(SignalKind::terminate()) {
                Ok(mut sig) => {
                    sig.recv().await;
                    app_handle_sigterm.exit(0);
                }
                Err(e) => eprintln!("[frondose] SIGTERM handler init failed: {}", e),
            }
        }
        #[cfg(windows)]
        {
            match tokio::signal::ctrl_c().await {
                Ok(()) => app_handle_sigterm.exit(0),
                Err(e) => eprintln!("[frondose] ctrl_c handler init failed: {}", e),
            }
        }
    });

    // P-58d.1 [3b/CMR-2]: sidecar readiness is now NON-FATAL (was std::process::exit(1)).
    // Same 10s budget → happy path unchanged (window appears once the sidecar is healthy);
    // on failure we LOG + proceed to a degraded window so the updater (spawned above) can
    // recover a bad release instead of the app silently exiting.
    if let Err(e) = await_serve_ready(&state, 10_000).await {
        eprintln!(
            "[frondose] frondose serve not ready: {} — UI degraded; updater may recover a bad release",
            e
        );
    }

    // [P-75 D-19] Enable WKInspectable on the main webview so the orchestrator (and the
    // operator for ad-hoc debugging) can attach Safari's Web Inspector to inspect the
    // Tauri WebView's DOM, console, and storage. Requires the `devtools` Cargo feature.
    // Without this, macOS's WebKit content protection makes the WebView invisible to all
    // screen-capture APIs (screencapture, CGDisplayCreateImage, AX entire-contents) — a
    // hard limit for any dogfood-test orchestrator that tries to verify UI rendering.
    // Once enabled, Safari → Develop menu → <Mac name> → main shows the inspector.
    if let Some(w) = app.handle().get_webview_window("main") {
        #[cfg(feature = "devtools")]
        w.open_devtools();
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
            // window-close — the spawned `frondose serve` sidecar (+ agent loop + Chrome
            // control) would survive and keep driving the browser. Kill the sidecar and
            // force the app to exit so app-close reliably stops the agent.
            RunEvent::WindowEvent {
                label,
                event: WindowEvent::CloseRequested { api, .. },
                ..
            } => {
                // P-76.1 (E1): hide-to-tray instead of quit+kill. The window is HIDDEN (not destroyed) →
                // sidecar + agent + Chrome control keep running AND the SSE subscriber stays connected, so
                // the serve disconnect-belt (routes.ts:62-69) does NOT fire. The always-visible tray (E2) is
                // the D-RUN-1 "never invisible" guarantee; tray Quit (+ ExitRequested/SIGTERM) is the full stop.
                api.prevent_close();
                if let Some(win) = app_handle.get_webview_window(&label) {
                    let _ = win.hide();
                }
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
