use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU32, Ordering};
use std::sync::Arc;

use hyper::{Body, Client, Method, Request, StatusCode, Uri};
use serde_json::Value;
use tokio::process::Child;
use tokio::sync::Mutex;

/// Per-app state: bearer token + UDS path + sidecar child handle.
///
/// [P-75 D-24] `shutting_down` + `child_pid` added to support the sidecar-watchdog
/// supervisor task. The supervisor owns the Child during `.wait()` (which removes it
/// from the mutex), so `shutdown_sidecar` cannot reach it via the mutex. It instead
/// reads the current sidecar PID from `child_pid` and `libc::kill`s it directly;
/// the supervisor observes `shutting_down=true` after the wait returns and exits
/// without respawning. Both fields are atomics so all Arc-clones share them
/// (Tauri's `manage()` copies the Arc handles via `.clone()`, not the inner data).
pub(crate) struct FrondoseServeState {
    pub(crate) token: String,
    /// WIN-1: the sidecar's current loopback TCP port (0 = not ready). Shared
    /// Arc<AtomicU16> across all state clones so a supervised respawn (which gets a
    /// NEW ephemeral port) is visible to every request + the SSE subscriber.
    pub(crate) port: Arc<AtomicU16>,
    /// WIN-1: path the sidecar writes its chosen port to; Rust polls it on boot + respawn.
    pub(crate) port_file: PathBuf,
    pub(crate) parent_dir: PathBuf,
    pub(crate) child: Arc<Mutex<Option<Child>>>,
    pub(crate) shutting_down: Arc<AtomicBool>,
    pub(crate) child_pid: Arc<AtomicU32>,
}

/// Build a loopback HTTP URI for the sidecar's current port. Paths are static literals.
pub(crate) fn build_uri(port: u16, path: &str) -> Uri {
    format!("http://127.0.0.1:{}{}", port, path)
        .parse()
        .expect("static loopback uri")
}

/// One-shot loopback-TCP HTTP request (no keepalive). Returns response body as Value.
pub(crate) async fn uds_request(
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
