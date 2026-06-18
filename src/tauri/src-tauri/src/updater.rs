use serde_json::Value;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

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

/// P-58d.1: read the operator-set `updateServerUrl` directly from
/// ~/.frondose/agent/config.json (independent of the sidecar; the updater runs
/// around it). Falls back to ~/.mai/agent/config.json for the first-launch window
/// where Tauri boots before the sidecar migrates the data dir. None when
/// absent/null/empty → the updater is a clean no-op. Home via `config_home_dir()`
/// (cross-platform); no new crate dep (serde_json is already present).
pub(crate) fn read_update_server_url() -> Option<String> {
    let home = config_home_dir()?;
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
