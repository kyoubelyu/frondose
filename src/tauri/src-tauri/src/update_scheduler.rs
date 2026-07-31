use std::future::Future;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Notify;

pub(crate) async fn run_update_scheduler<F, Fut, I>(
    ready: Arc<Notify>,
    read_interval: I,
    mut check: F,
) where
    F: FnMut() -> Fut,
    Fut: Future<Output = ()>,
    I: Fn() -> Duration,
{
    ready.notified().await;
    check().await;

    let cadence = read_interval();
    if cadence.is_zero() {
        return;
    }

    let mut ticker = tokio::time::interval(cadence);
    ticker.tick().await;
    loop {
        ticker.tick().await;
        check().await;
    }
}
