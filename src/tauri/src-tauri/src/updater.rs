use serde_json::Value;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

/// P-UPDATE-INTRANET: baked-in intranet default so a fresh install auto-pulls
/// from intranet-host with no per-app config. Explicit null or "" remains the
/// operator opt-out.
const DEFAULT_UPDATE_SERVER_URL: &str = "http://intranet-host.local:4875";

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

    const EXPECTED_DEFAULT_URL: &str = "http://intranet-host.local:4875";

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
}
