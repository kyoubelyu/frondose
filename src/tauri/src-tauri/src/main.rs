#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod resolve;
mod sidecar;
mod sse;
mod state;
mod updater;

// P-56a M-1 SCAFFOLD: Tauri shell for the v0.5 hover pivot. Throwaway-scope -
// the entire file may be restructured in P-56b/M-2/M-3. Approved-site for
// child_process via tokio::process::Command (see CLAUDE.md HR-8).

use crate::commands::{
    frondose_agent_abort, frondose_agent_retry, frondose_agent_turn, frondose_check_update,
    frondose_chrome_ensure, frondose_get_settings, frondose_health, frondose_identity,
    frondose_set_cron_mode, frondose_set_passive_mode, frondose_set_settings,
    frondose_workflow_approve, frondose_workflow_cancel, frondose_workflow_decline,
    frondose_workflow_handoff,
};
use crate::sidecar::{
    await_serve_ready, shutdown_sidecar, spawn_frondose_serve, supervise_sidecar,
};
use crate::sse::run_sse_subscriber;
use crate::state::FrondoseServeState;
use crate::resolve::provision_state;
use crate::updater::{
    read_update_check_interval_sec, read_update_server_url, run_update_check,
};

use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU32};
use std::sync::Arc;
use std::time::Duration;

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, RunEvent, WindowEvent};
use tokio::sync::{Mutex, Notify};

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
