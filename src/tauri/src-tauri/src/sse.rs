use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use crate::state::{build_uri, FrondoseServeState};
use hyper::body::HttpBody;
use hyper::{Body, Client, Method, Request, StatusCode};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

/// P-56b SSE subscriber: reconnecting UDS stream reader forwarding data frames to the WebView.
pub(crate) async fn run_sse_subscriber(app: AppHandle, state: Arc<FrondoseServeState>) {
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
