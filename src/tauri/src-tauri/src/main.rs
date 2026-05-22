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
use tauri::{AppHandle, Emitter, RunEvent};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

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

/// Spawn `node <mai_bin> serve --sock <path> --token <tok>` as a child process.
async fn spawn_mai_serve(sock: &PathBuf, token: &str) -> Result<Child, String> {
    // Resolve the mai dist path. Dev override: MAI_BIN_PATH env var.
    // Default for dev: `../../../dist/cli/main.js` relative to src-tauri/.
    let mai_bin = std::env::var("MAI_BIN_PATH").unwrap_or_else(|_| "../../../dist/cli/main.js".to_string());
    let child = Command::new("node")
        .arg(&mai_bin)
        .arg("serve")
        .arg("--sock")
        .arg(sock.to_str().ok_or("invalid sock path utf-8")?)
        .arg("--token")
        .arg(token)
        .env("MAI_AUTOUPDATE", "skip")
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
    let child = spawn_mai_serve(&sock_path, &token).await.expect("spawn mai serve");

    let state = MaiServeState {
        token,
        sock_path: sock_path.clone(),
        parent_dir: parent_dir.clone(),
        child: Arc::new(Mutex::new(Some(child))),
    };
    if let Err(e) = await_serve_ready(&state, 10_000).await {
        eprintln!("[mai-tauri] mai serve startup failed: {}", e);
        shutdown_sidecar(&state).await;
        std::process::exit(1);
    }
    let state = Arc::new(state);
    let state_clone = state.clone();

    let app = tauri::Builder::default()
        .manage(MaiServeState {
            token: state.token.clone(),
            sock_path: state.sock_path.clone(),
            parent_dir: state.parent_dir.clone(),
            child: state.child.clone(),
        })
        .invoke_handler(tauri::generate_handler![
            mai_health,
            mai_identity,
            mai_chrome_ensure,
            mai_agent_turn,
            mai_agent_abort,
            mai_agent_retry,
            mai_set_cron_mode,
            mai_set_passive_mode
        ])
        .build(tauri::generate_context!())
        .expect("Tauri build");

    // P-56b: spawn SSE subscriber + SIGTERM handler before the blocking app.run().
    let app_handle = app.handle().clone();
    let app_handle_sse = app_handle.clone();
    let state_for_sse = state.clone();
    tokio::spawn(async move {
        run_sse_subscriber(app_handle_sse, state_for_sse).await;
    });

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

    app.run(move |_app_handle, event| {
        if let RunEvent::ExitRequested { .. } = event {
            let state_for_shutdown = state_clone.clone();
            tauri::async_runtime::block_on(async {
                shutdown_sidecar(&state_for_shutdown).await;
            });
        }
    });
}

// libc for signals - declared as a direct dep in Cargo.toml (rev-1 Step 3b NIT-N1 fix).
// On macOS, `libc::SIGTERM` + `libc::kill` are used to gracefully signal the sidecar.
