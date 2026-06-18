use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use crate::resolve::{resolve_node, resolve_sidecar_bin};
#[cfg(windows)] use crate::resolve::windows_sidecar_log_path;
use crate::state::{uds_request, FrondoseServeState};
use hyper::Method;
use tokio::process::{Child, Command};

/// Spawn `node <sidecar_bin> --port-file <path> --token <tok>` as a child process.
pub(crate) async fn spawn_frondose_serve(port_file: &PathBuf, token: &str) -> Result<Child, String> {
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
pub(crate) async fn await_serve_ready(state: &FrondoseServeState, timeout_ms: u64) -> Result<(), String> {
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
pub(crate) async fn shutdown_sidecar(state: &FrondoseServeState) {
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
pub(crate) async fn supervise_sidecar(state: Arc<FrondoseServeState>) {
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
