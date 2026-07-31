use crate::state::{uds_request, FrondoseServeState};
use crate::update_notice::take_update_notice_response;
use crate::updater::read_update_server_url;
use hyper::Method;
use serde_json::{json, Value};
use tauri_plugin_updater::UpdaterExt;

#[tauri::command]
pub(crate) async fn frondose_health(
    state: tauri::State<'_, FrondoseServeState>,
) -> Result<Value, String> {
    uds_request(state.inner(), Method::GET, "/health", None).await
}

#[tauri::command]
pub(crate) async fn frondose_identity(
    state: tauri::State<'_, FrondoseServeState>,
) -> Result<Value, String> {
    uds_request(state.inner(), Method::GET, "/identity", None).await
}

#[tauri::command]
pub(crate) async fn frondose_chrome_ensure(
    state: tauri::State<'_, FrondoseServeState>,
) -> Result<Value, String> {
    uds_request(
        state.inner(),
        Method::POST,
        "/chrome/ensure",
        Some(json!({})),
    )
    .await
}

// P-Y6 — in-app settings (auth/identity/soul). Mirror frondose_identity → GET /settings;
// frondose_set_settings POSTs the masked-safe patch. The serve handler returns a masked view.
#[tauri::command]
pub(crate) async fn frondose_get_settings(
    state: tauri::State<'_, FrondoseServeState>,
) -> Result<Value, String> {
    uds_request(state.inner(), Method::GET, "/settings", None).await
}

#[tauri::command]
pub(crate) async fn frondose_set_settings(
    state: tauri::State<'_, FrondoseServeState>,
    settings: Value,
) -> Result<Value, String> {
    uds_request(state.inner(), Method::POST, "/settings", Some(settings)).await
}

// P-58d.1 — manual "Check for updates" trigger (OQ-58d.6). Custom command (no
// plugin command exposed to JS → no capability change). The Settings-panel
// button that calls this ships in P-58d.1-UI.
#[tauri::command]
pub(crate) async fn frondose_check_update(app: tauri::AppHandle) -> Result<Value, String> {
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
            // P-FIX-MAC-UPDATER-RELAUNCH: route through the shared helper — this fixes
            // TWO latent bugs in the old bare download-and-install + restart()
            // shape: (a) on Windows, restart() re-locked the exe before NSIS could swap
            // it AND the sidecar was never killed (locked runtime\node.exe); (b) on
            // macOS, restart() after the bundle swap silently exits without relaunching.
            // Busy → Err("already_updating") propagates to the FE as a stable string.
            crate::updater::install_and_relaunch(&app, update).await?;
            // Reached when exit has been REQUESTED (macOS accepted relaunch) or never
            // (Windows: install() diverged inside the plugin). The invoke promise may
            // resolve pre-teardown; the FE trusts the update-status event stream.
            Ok(json!({ "ok": true, "updateAvailable": true }))
        }
        None => Ok(json!({ "ok": true, "updateAvailable": false })),
    }
}

#[tauri::command]
pub(crate) fn frondose_take_update_notice() -> Value {
    take_update_notice_response(env!("CARGO_PKG_VERSION"))
}

#[tauri::command]
pub(crate) async fn frondose_agent_turn(
    state: tauri::State<'_, FrondoseServeState>,
    prompt: String,
) -> Result<Value, String> {
    uds_request(
        state.inner(),
        Method::POST,
        "/agent/turn",
        Some(json!({"prompt": prompt})),
    )
    .await
}

#[tauri::command]
pub(crate) async fn frondose_agent_auto_start(
    state: tauri::State<'_, FrondoseServeState>,
    prompt: String,
    interval_minutes: Option<u32>,
) -> Result<Value, String> {
    uds_request(
        state.inner(),
        Method::POST,
        "/agent/auto/start",
        Some(json!({"prompt": prompt, "intervalMinutes": interval_minutes})),
    )
    .await
}

#[tauri::command]
pub(crate) async fn frondose_agent_auto_stop(
    state: tauri::State<'_, FrondoseServeState>,
) -> Result<Value, String> {
    uds_request(
        state.inner(),
        Method::POST,
        "/agent/auto/stop",
        Some(json!({})),
    )
    .await
}

#[tauri::command]
pub(crate) async fn frondose_agent_abort(
    state: tauri::State<'_, FrondoseServeState>,
) -> Result<Value, String> {
    uds_request(state.inner(), Method::POST, "/agent/abort", Some(json!({}))).await
}

#[tauri::command]
pub(crate) async fn frondose_agent_retry(
    state: tauri::State<'_, FrondoseServeState>,
) -> Result<Value, String> {
    uds_request(state.inner(), Method::POST, "/agent/retry", Some(json!({}))).await
}

#[tauri::command]
pub(crate) async fn frondose_set_cron_mode(
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
pub(crate) async fn frondose_set_passive_mode(
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
pub(crate) async fn frondose_workflow_approve(
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
pub(crate) async fn frondose_workflow_decline(
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
pub(crate) async fn frondose_workflow_handoff(
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
pub(crate) async fn frondose_workflow_cancel(
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
