use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// P-UPDATE-INTRANET: baked-in intranet default so a fresh install auto-pulls
/// with no per-app config. Uses intranet-host's FIXED intranet IP (not `.local`, which
/// Windows can't resolve without mDNS/Bonjour — an IP resolves on every platform).
/// Explicit null or "" remains the operator opt-out. FUTURE PUBLIC deployment: set
/// config.json `updateServerUrl` to the public URL (runtime, no rebuild), or change
/// this const + the config.ts twin + rebuild for a new baked default.
const DEFAULT_UPDATE_SERVER_URL: &str = "http://192.0.2.105:4875";

/// CH-5: cross-platform home dir for the update-config reads. macOS/Unix use
/// `$HOME`; Windows uses `%USERPROFILE%` (`$HOME` is empty there), matching the
/// Node sidecar's `os.homedir()` so both sides resolve the same
/// `~/.frondose/agent/config.json`. Without this the Windows auto-updater config
/// was unreadable (server URL always None, interval always the default).
fn config_home_dir() -> Option<String> {
    if let Ok(home) = std::env::var("HOME") {
        if !home.trim().is_empty() {
            return Some(home);
        }
    }
    std::env::var("USERPROFILE").ok().filter(|p| !p.trim().is_empty())
}

/// P-58d.1 / P-UPDATE-INTRANET: read the operator-set `updateServerUrl`
/// directly from ~/.frondose/agent/config.json (independent of the sidecar; the
/// updater runs around it). Falls back to ~/.mai/agent/config.json for the
/// first-launch window where Tauri boots before the sidecar migrates the data
/// dir. Absent file/key, unparseable JSON, or non-string values use the baked
/// intranet default; explicit null or "" disables the updater.
pub(crate) fn read_update_server_url() -> Option<String> {
    let Some(home) = config_home_dir() else {
        return Some(DEFAULT_UPDATE_SERVER_URL.to_string());
    };
    let new_path = std::path::Path::new(&home).join(".frondose/agent/config.json");
    let raw = std::fs::read_to_string(&new_path).or_else(|_| {
        let legacy = std::path::Path::new(&home).join(".mai/agent/config.json");
        std::fs::read_to_string(legacy)
    });
    let Ok(raw) = raw else {
        return Some(DEFAULT_UPDATE_SERVER_URL.to_string());
    };
    let Ok(v) = serde_json::from_str::<Value>(&raw) else {
        return Some(DEFAULT_UPDATE_SERVER_URL.to_string());
    };
    match v.get("updateServerUrl") {
        None => Some(DEFAULT_UPDATE_SERVER_URL.to_string()),
        Some(Value::Null) => None,
        Some(x) => match x.as_str().map(|s| s.trim().to_string()) {
            Some(s) if s.is_empty() => None,
            Some(s) => Some(s),
            None => Some(DEFAULT_UPDATE_SERVER_URL.to_string()),
        },
    }
}

/// P-58d.3 — Periodic update-check interval in seconds. Reads
/// `updateCheckIntervalSec` from ~/.frondose/agent/config.json, with the same
/// first-launch fallback to ~/.mai/agent/config.json. Defaults to 3600 (1 hour)
/// — early-release operator directive 2026-06-09: "发布初期会经常更新".
/// Floor of 60s (sanity guard against a config typo that hammers the server).
/// Returning 0 disables periodic polling (operator opt-out without removing
/// updateServerUrl).
pub(crate) fn read_update_check_interval_sec() -> u64 {
    let default_sec: u64 = 3600;
    let Some(home) = config_home_dir() else {
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

// ─── P-FIX-MAC-UPDATER-RELAUNCH (2026-07-13) — shared install/relaunch path ───────────
//
// One download→shutdown→install→relaunch pipeline for the boot/periodic checker AND the
// manual Settings command (commands.rs::frondose_check_update). Design + critic gates:
// docs/phase-mac-relaunch-plan.md §3/§6 + docs/phase-mac-relaunch-critics-r2.md.

/// [MR-3] Process-wide update-in-progress guard (boot + periodic + manual paths).
static UPDATE_IN_PROGRESS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Stable busy-rejection string — the Settings FE matches on this exact value.
pub(crate) const ALREADY_UPDATING: &str = "already_updating";

fn try_begin_update() -> bool {
    UPDATE_IN_PROGRESS
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
        )
        .is_ok()
}

fn end_update() {
    UPDATE_IN_PROGRESS.store(false, std::sync::atomic::Ordering::SeqCst);
}

/// FE contract (plan §3c): Tauri event `update-status`, payload
/// `{ stage: "downloading"|"installing"|"relaunching"|"error", version?, message? }`.
fn emit_update_status(app: &AppHandle, stage: &str, extra: Option<(&str, String)>) {
    let mut payload = json!({ "stage": stage });
    if let Some((k, v)) = extra {
        payload[k] = Value::String(v);
    }
    let _ = app.emit("update-status", payload);
}

/// Operator-approved CLI-layer spawn site (2026-07-13, ROADMAP § Approved CLI-layer
/// child_process sites): the ABSOLUTE system path — never a PATH lookup.
#[cfg(any(target_os = "macos", test))]
pub(crate) const MACOS_OPEN_BIN: &str = "/usr/bin/open";

/// [T-RELAUNCH.5] Exactly `/usr/bin/open -n <bundle>` — one non-shell path argument.
#[cfg(any(target_os = "macos", test))]
pub(crate) fn macos_open_args(bundle: &std::path::Path) -> (&'static str, Vec<std::ffi::OsString>) {
    (MACOS_OPEN_BIN, vec!["-n".into(), bundle.as_os_str().to_os_string()])
}

/// Pure: `…/<name>.app/Contents/MacOS/<exe>` → the bundle root, else None.
#[cfg(any(target_os = "macos", test))]
pub(crate) fn macos_bundle_from_exe(exe: &std::path::Path) -> Option<std::path::PathBuf> {
    let macos_dir = exe.parent()?;
    if macos_dir.file_name()? != "MacOS" {
        return None;
    }
    let contents = macos_dir.parent()?;
    if contents.file_name()? != "Contents" {
        return None;
    }
    let bundle = contents.parent()?;
    if bundle.extension()? != "app" {
        return None;
    }
    Some(bundle.to_path_buf())
}

/// [MR-6] Pure: any `AppTranslocation` path component → translocated run (unsupported —
/// the plugin would have installed into the randomized translocation point).
#[cfg(any(target_os = "macos", test))]
pub(crate) fn path_is_translocated(p: &std::path::Path) -> bool {
    p.components().any(|c| c.as_os_str() == "AppTranslocation")
}

/// [MR-6] Fresh (non-ctor-cached) exe resolution + translocation refusal + bundle-shape
/// validation. Errors are operator-visible and fire BEFORE any download.
#[cfg(target_os = "macos")]
fn resolve_macos_bundle_path() -> Result<std::path::PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let exe = exe
        .canonicalize()
        .map_err(|e| format!("canonicalize {}: {e}", exe.display()))?;
    if path_is_translocated(&exe) {
        return Err(format!(
            "Frondose is running App-Translocated ({}) — move Frondose.app to /Applications and reopen before updating",
            exe.display()
        ));
    }
    macos_bundle_from_exe(&exe)
        .ok_or_else(|| format!("executable {} is not inside a .app bundle", exe.display()))
}

/// [MR-2 / T-RELAUNCH.6] Bounded, status-checked spawn, factored over (bin, args) so real
/// negative-path units drive it against /usr/bin/true, /usr/bin/false, a nonexistent
/// binary, and a sleep-timeout — without touching the production bin choice.
#[cfg(any(target_os = "macos", test))]
async fn run_relaunch_command(
    bin: &str,
    args: &[std::ffi::OsString],
    timeout_secs: u64,
) -> Result<(), String> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let status = tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), cmd.status())
        .await
        .map_err(|_| format!("{bin} timed out after {timeout_secs}s"))?
        .map_err(|e| format!("spawn {bin}: {e}"))?;
    if !status.success() {
        return Err(format!("{bin} exited with {status}"));
    }
    Ok(())
}

/// [MR-2] `/usr/bin/open -n <bundle>` — Ok means LaunchServices ACCEPTED the launch.
/// Release builds: the bin is the hardcoded absolute MACOS_OPEN_BIN, no env influence.
/// Debug builds ONLY (plan §7 Stage B3 forced-failure drill): FRONDOSE_DEBUG_OPEN_BIN may
/// override the bin; compiled OUT of release via cfg(debug_assertions).
#[cfg(target_os = "macos")]
async fn relaunch_macos(bundle: &std::path::Path) -> Result<(), String> {
    const OPEN_TIMEOUT_SECS: u64 = 10;
    let (bin, args) = macos_open_args(bundle);
    #[cfg(debug_assertions)]
    let debug_bin = std::env::var("FRONDOSE_DEBUG_OPEN_BIN").ok();
    #[cfg(debug_assertions)]
    let bin = debug_bin.as_deref().unwrap_or(bin);
    run_relaunch_command(bin, &args, OPEN_TIMEOUT_SECS).await
}

/// [MR-3 / T-RELAUNCH.7] Bounded poll on the supervisor-owned pid slot (0 = reaped).
async fn await_pid_cleared(pid: &std::sync::atomic::AtomicU32, timeout_ms: u64) -> bool {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    while pid.load(std::sync::atomic::Ordering::SeqCst) != 0 && std::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    pid.load(std::sync::atomic::Ordering::SeqCst) == 0
}

/// [MR-3] shutdown_sidecar + bounded reap observation (the supervisor stores child_pid=0
/// when child.wait() returns — see sidecar.rs D-24 ownership contract).
async fn shutdown_sidecar_observed(app: &AppHandle) {
    const REAP_TIMEOUT_MS: u64 = 5_000;
    let state = app.state::<crate::state::FrondoseServeState>();
    crate::sidecar::shutdown_sidecar(&state).await;
    if !await_pid_cleared(&state.child_pid, REAP_TIMEOUT_MS).await {
        let leftover = state.child_pid.load(std::sync::atomic::Ordering::SeqCst);
        eprintln!(
            "[frondose] update: sidecar pid={leftover} not reaped within {REAP_TIMEOUT_MS}ms — proceeding"
        );
    }
}

/// P-FIX-MAC-UPDATER-RELAUNCH: the ONE download→shutdown→install→relaunch path.
///
/// Ordering is load-bearing [MR-1]: download()+signature-verify FIRST (a failed download
/// leaves the sidecar untouched → fully usable app), only then sidecar shutdown (Windows:
/// NSIS cannot overwrite the locked runtime\node.exe; macOS: no agent mid-swap), then
/// install(bytes). Platform tails:
///   windows — Update::install() extracts → on_before_exit → ShellExecuteW(NSIS) →
///             std::process::exit(0): it DIVERGES (plugin 2.10.1 updater.rs:787-866), so
///             "relaunching" is emitted BEFORE install and the app.exit(0) after it is a
///             defensive intent marker. NSIS owns the relaunch (live-proven path).
///   macos   — /usr/bin/open -n <bundle>, status-checked [MR-2]; exit ONLY on accepted
///             zero status; failure keeps the old process alive with a visible error.
///   linux   — preserves the pre-existing restart() behavior verbatim [MR-7].
pub(crate) async fn install_and_relaunch(app: &AppHandle, update: Update) -> Result<(), String> {
    if !try_begin_update() {
        return Err(ALREADY_UPDATING.to_string());
    }
    // [MR-6] macOS: refuse unsupported install locations BEFORE any download.
    #[cfg(target_os = "macos")]
    let bundle = match resolve_macos_bundle_path() {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[frondose] update refused: {e}");
            emit_update_status(app, "error", Some(("message", e.clone())));
            end_update();
            return Err(e);
        }
    };

    emit_update_status(app, "downloading", Some(("version", update.version.clone())));

    // [MR-1] Download + signature-verify FIRST. The plugin's on_download_finish callback
    // fires BEFORE signature verification, so it must not drive any stage → no-ops.
    let bytes = match update.download(|_chunk, _total| {}, || {}).await {
        Ok(b) => b,
        Err(e) => {
            let msg = format!("update download failed: {e}");
            eprintln!("[frondose] {msg}");
            emit_update_status(app, "error", Some(("message", msg.clone())));
            end_update();
            return Err(msg);
        }
    };

    emit_update_status(app, "installing", None);
    shutdown_sidecar_observed(app).await;

    #[cfg(target_os = "windows")]
    emit_update_status(app, "relaunching", None);

    if let Err(e) = update.install(&bytes) {
        // [MR-1] Post-shutdown failure: the sidecar is down (degraded, honestly). The
        // updater is sidecar-independent by design, so a retry re-downloads/installs and
        // a success relaunches into a fresh process; manual quit+reopen also recovers.
        let msg = format!(
            "update install failed after download: {e} — retry Check for updates, or quit and reopen Frondose"
        );
        eprintln!("[frondose] {msg}");
        emit_update_status(app, "error", Some(("message", msg.clone())));
        end_update();
        return Err(msg);
    }

    #[cfg(target_os = "windows")]
    {
        // Unreachable with the pinned plugin (install() exits) — defensive intent marker.
        app.exit(0);
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        emit_update_status(app, "relaunching", None);
        match relaunch_macos(&bundle).await {
            Ok(()) => {
                // LaunchServices ACCEPTED the new instance — only now request exit.
                // AppHandle::exit(0) returns () (requests exit; non-diverging) [MR-7];
                // ExitRequested re-runs shutdown_sidecar (idempotent; pid already 0).
                // The guard deliberately stays held: this process is tearing down.
                app.exit(0);
                Ok(())
            }
            Err(e) => {
                // [MR-2] Do NOT exit. The new version IS installed on disk; keep the old
                // window alive so the error is visible; a manual reopen completes it.
                let msg = format!(
                    "update installed, but relaunch failed: {e} — quit and reopen Frondose manually"
                );
                eprintln!("[frondose] {msg}");
                emit_update_status(app, "error", Some(("message", msg.clone())));
                end_update();
                Err(msg)
            }
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        // [MR-7] Linux (AppImage in-place swap): preserve current behavior exactly.
        emit_update_status(app, "relaunching", None);
        app.restart(); // -> ! (diverges)
    }
}

/// P-58d.1: check the runtime-configured update endpoint once at launch
/// (OQ-58d.6: check-on-launch). Runs in a spawned task so a down/slow server
/// never blocks the UI. No URL → returns immediately. On a found update:
/// download → install → restart. All failures are logged + swallowed (a broken
/// updater must NOT crash the app).
pub(crate) async fn run_update_check(app: AppHandle) {
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
            // P-FIX-MAC-UPDATER-RELAUNCH: the download→shutdown→install→relaunch
            // pipeline (incl. the Windows sidecar-kill-before-NSIS-install and the
            // per-platform relaunch split) lives in install_and_relaunch. Errors are
            // already emitted as update-status events; swallow-and-log preserves
            // "a broken updater must NOT crash the app".
            if let Err(e) = install_and_relaunch(&app, update).await {
                eprintln!("[frondose] update aborted: {e}");
            }
        }
        Ok(None) => eprintln!("[frondose] no update available"),
        Err(e) => eprintln!("[frondose] update check failed: {}", e),
    }
}

#[cfg(test)]
mod tests {
    //! P-UPDATE-INTRANET Step 3a (validator, revised per
    //! `docs/phase-update-intranet-critics.md` CONCERN-MR-1): scaffolds for
    //! T-Updater.1-4 + T-Updater.2b — the three-way default-URL precedence
    //! `read_update_server_url()` implements at Step 4 (plan §6.A, Option B).
    //! Assertions target Option-B behavior (absent key/file → baked default;
    //! explicit null OR "" → disabled/None; explicit url → override). Post-Step-4
    //! all five pass: T-Updater.1 (absent → baked default) is the behavior this
    //! phase ADDED; T-Updater.2/.2b/.3/.4 were already-green regression pins —
    //! the source already returns `None` for an explicit `null` (the first `?`
    //! on `v.get("updateServerUrl")?.as_str()`
    //! short-circuits for `Value::Null` exactly like a missing key), so Option
    //! B's null-disables contract needs NO Rust code change, only these
    //! flipped/added test names to stop the scaffold asserting the wrong
    //! (rejected) "null → default" behavior. Asserted by literal string value
    //! (not the not-yet-existing `DEFAULT_UPDATE_SERVER_URL` const name).
    use super::*;
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    const EXPECTED_DEFAULT_URL: &str = "http://192.0.2.105:4875";

    // Serializes HOME env-var mutation across these tests only — cargo test runs
    // test fns in parallel threads by default and HOME is process-global. No new
    // crate dep: a local Mutex is enough since no other test in this crate reads
    // HOME (grep-verified at scaffold time).
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// RAII guard: points HOME at a fresh temp dir for the test's duration and
    /// restores the previous HOME (or removes it) on drop, even on panic. Never
    /// touches the real ~/.frondose.
    struct TempHome {
        dir: std::path::PathBuf,
        original: Option<String>,
    }

    impl TempHome {
        fn new(tag: &str) -> Self {
            let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let dir = std::env::temp_dir().join(format!("frondose-updater-test-{}-{}", tag, nanos));
            std::fs::create_dir_all(&dir).unwrap();
            let original = std::env::var("HOME").ok();
            std::env::set_var("HOME", &dir);
            TempHome { dir, original }
        }

        /// Writes ~/.frondose/agent/config.json with the given raw JSON body.
        fn write_config(&self, json: &str) {
            let agent_dir = self.dir.join(".frondose/agent");
            std::fs::create_dir_all(&agent_dir).unwrap();
            std::fs::write(agent_dir.join("config.json"), json).unwrap();
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            match &self.original {
                Some(v) => std::env::set_var("HOME", v),
                None => std::env::remove_var("HOME"),
            }
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    // T-Updater.1: given no ~/.frondose/agent/config.json on disk, when
    // read_update_server_url() runs, then it returns Some(the baked intranet
    // default) — covers the fresh-install auto-pull window (plan §6.A).
    // RED against current source (returns None today for an absent config file).
    #[test]
    fn t_updater_1_absent_config_returns_baked_default() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _home = TempHome::new("absent");
        assert_eq!(read_update_server_url(), Some(EXPECTED_DEFAULT_URL.to_string()));
    }

    // T-Updater.2: given config.json with "updateServerUrl": null, when read,
    // then None — the operator "clear the field" opt-out (plan §6.A Option B,
    // CONCERN-MR-1 fix). FLIPPED from the prior draft's "null → default":
    // already-green today (explicit null already returns None — the `?` on
    // `.as_str()` short-circuits for Value::Null), regression-pinning the
    // preserved disable semantics rather than asserting the rejected behavior.
    #[test]
    fn t_updater_2_null_config_value_disables_update_check() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = TempHome::new("null");
        home.write_config(r#"{"schema_version":2,"updateServerUrl":null}"#);
        assert_eq!(read_update_server_url(), None);
    }

    // T-Updater.2b (validator-added, CONCERN-MR-1 cross-layer coherence):
    // given the exact config.json shape the settings API/UI
    // "clear the field" save produces (schema_version:2, other fields
    // populated, updateServerUrl EXPLICITLY null — settings.ts:175 writes
    // `next.updateServerUrl = patch.updateServerUrl` verbatim), when
    // read_update_server_url() then reads that file, then None — proves the
    // operator's Settings-clear gesture disables the updater end-to-end under
    // Option B, not just a bare-minimum JSON fixture. Already-green (same
    // code path as T-Updater.2; the settings writer itself is covered by its
    // own TS test at tests/tauri/updater-ui-p58d1.mock.test.ts:270-310).
    #[test]
    fn t_updater_2b_settings_clear_produced_null_disables_update_check() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = TempHome::new("settings-clear");
        home.write_config(
            r#"{"schema_version":2,"server":{"url":null,"bind_address":null,"poll_interval_s":30,"web_port":8090,"ssh_user":null,"ssh_port":22,"rest_port":3031},"worker":{"id":null,"hostname":null,"label":null,"input_mode":"cdp"},"telegram":{"enabled":false,"boundUserId":null,"proxyUrl":null},"soul":{"override":null},"updateServerUrl":null,"language":"auto"}"#,
        );
        assert_eq!(read_update_server_url(), None);
    }

    // T-Updater.3: given config.json with "updateServerUrl": "", when read, then
    // None — the explicit opt-out is PRESERVED by the sketch (plan §6.A).
    // Already-green today (empty string already returns None) — regression pin.
    #[test]
    fn t_updater_3_explicit_empty_string_disables_update_check() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = TempHome::new("empty");
        home.write_config(r#"{"schema_version":2,"updateServerUrl":""}"#);
        assert_eq!(read_update_server_url(), None);
    }

    // T-Updater.4: given config.json with an explicit override URL, when read,
    // then Some(that URL) — operator override takes precedence over the default
    // (plan §6.A). Already-green today (override already works) — regression pin.
    #[test]
    fn t_updater_4_explicit_override_url_wins() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = TempHome::new("override");
        home.write_config(r#"{"schema_version":2,"updateServerUrl":"http://other:9999"}"#);
        assert_eq!(read_update_server_url(), Some("http://other:9999".to_string()));
    }

    // ── P-FIX-MAC-UPDATER-RELAUNCH Step 5 — T-RELAUNCH.1–7 (docs/phase-mac-relaunch-plan.md §5) ──

    // T-RELAUNCH.1: given a well-formed …/<name>.app/Contents/MacOS/<exe> path, when
    // macos_bundle_from_exe runs, then it returns Some(bundle root).
    #[test]
    fn t_relaunch_1_wellformed_bundle_exe_resolves_bundle_root() {
        let exe = std::path::Path::new("/Applications/Frondose.app/Contents/MacOS/Frondose");
        assert_eq!(
            macos_bundle_from_exe(exe),
            Some(std::path::PathBuf::from("/Applications/Frondose.app"))
        );
    }

    // T-RELAUNCH.2: given malformed trees (no bundle, wrong dir names, bundle dir without
    // .app extension), when macos_bundle_from_exe runs, then None for each.
    #[test]
    fn t_relaunch_2_malformed_trees_return_none() {
        for bad in [
            "/usr/local/bin/frondose",
            "/Applications/Frondose.app/Contents/Resources/x",
            "/Applications/Frondose.app/NotContents/MacOS/x",
            "/Applications/Frondose/Contents/MacOS/Frondose",
        ] {
            assert_eq!(
                macos_bundle_from_exe(std::path::Path::new(bad)),
                None,
                "expected None for {bad}"
            );
        }
    }

    // T-RELAUNCH.3: given a canonical App-Translocation path, when path_is_translocated
    // runs, then true; a normal /Applications path → false. [MR-6]
    #[test]
    fn t_relaunch_3_apptranslocation_component_detected() {
        let t = std::path::Path::new(
            "/private/var/folders/ab/T/AppTranslocation/8F0A-11/d/Frondose.app/Contents/MacOS/Frondose",
        );
        assert!(path_is_translocated(t));
        assert!(!path_is_translocated(std::path::Path::new(
            "/Applications/Frondose.app/Contents/MacOS/Frondose"
        )));
    }

    // T-RELAUNCH.4: given the update guard, when begun twice, then the second begin fails
    // until end_update releases it. [MR-3] Single test owns the whole sequence — the guard
    // static is process-global and no other test touches it.
    #[test]
    fn t_relaunch_4_update_guard_serializes() {
        assert!(try_begin_update(), "first begin must acquire");
        assert!(!try_begin_update(), "second begin must be rejected while held");
        end_update();
        assert!(try_begin_update(), "begin must succeed again after release");
        end_update();
    }

    // T-RELAUNCH.5: given a bundle path, when macos_open_args builds the spawn spec, then
    // it is EXACTLY ("/usr/bin/open", ["-n", <bundle>]) — the operator-approved site:
    // absolute path, -n, one non-shell argument. [MR-2]
    #[test]
    fn t_relaunch_5_open_command_is_absolute_open_dash_n_bundle() {
        let bundle = std::path::Path::new("/Applications/Frondose.app");
        let (bin, args) = macos_open_args(bundle);
        assert_eq!(bin, "/usr/bin/open");
        assert_eq!(
            args,
            vec![
                std::ffi::OsString::from("-n"),
                std::ffi::OsString::from("/Applications/Frondose.app")
            ]
        );
    }

    // T-RELAUNCH.6a: given /usr/bin/true, when run_relaunch_command runs, then Ok —
    // an accepted zero exit status is the ONLY success. [MR-2, real process]
    #[cfg(unix)]
    #[tokio::test]
    async fn t_relaunch_6a_zero_exit_is_ok() {
        assert_eq!(run_relaunch_command("/usr/bin/true", &[], 5).await, Ok(()));
    }

    // T-RELAUNCH.6b: given /usr/bin/false, when run, then Err carrying the nonzero status
    // — a spawned-but-rejected launch must NOT look like success. [MR-2, real process]
    #[cfg(unix)]
    #[tokio::test]
    async fn t_relaunch_6b_nonzero_exit_is_err() {
        let r = run_relaunch_command("/usr/bin/false", &[], 5).await;
        let e = r.expect_err("nonzero exit must be Err");
        assert!(e.contains("exited with"), "err must carry the status: {e}");
    }

    // T-RELAUNCH.6c: given a nonexistent binary, when run, then Err from spawn — the
    // spawn-failure shape that vendored restart() swallowed invisibly. [MR-2, real process]
    #[cfg(unix)]
    #[tokio::test]
    async fn t_relaunch_6c_missing_binary_is_spawn_err() {
        let r = run_relaunch_command("/nonexistent/frondose-test-bin", &[], 5).await;
        let e = r.expect_err("missing binary must be Err");
        assert!(e.starts_with("spawn "), "err must be the spawn shape: {e}");
    }

    // T-RELAUNCH.6d: given /bin/sleep 60 with a 1s bound, when run, then Err(timeout) —
    // the bounded wait can never hang the updater. [MR-2, real process]
    #[cfg(unix)]
    #[tokio::test]
    async fn t_relaunch_6d_timeout_is_err() {
        let args = vec![std::ffi::OsString::from("60")];
        let r = run_relaunch_command("/bin/sleep", &args, 1).await;
        let e = r.expect_err("over-bound child must time out");
        assert!(e.contains("timed out"), "err must be the timeout shape: {e}");
    }

    // T-RELAUNCH.7: given the pid slot, when await_pid_cleared polls, then: already-0 →
    // true immediately; cleared-late (200ms) → true; never-cleared → false at timeout. [MR-3]
    #[tokio::test]
    async fn t_relaunch_7_pid_poll_seam() {
        use std::sync::atomic::{AtomicU32, Ordering};
        use std::sync::Arc;

        let already = AtomicU32::new(0);
        assert!(await_pid_cleared(&already, 500).await, "pid already 0 → immediate true");

        let late = Arc::new(AtomicU32::new(7));
        let late_clone = late.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            late_clone.store(0, Ordering::SeqCst);
        });
        assert!(await_pid_cleared(&late, 2_000).await, "pid cleared at ~200ms → true within bound");

        let never = AtomicU32::new(9);
        assert!(!await_pid_cleared(&never, 250).await, "pid never cleared → false at timeout");
    }
}
