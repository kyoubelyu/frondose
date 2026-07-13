// P-UI-THINK-OVERLAY (2026-07-13): scroll-pinning helpers extracted from app.ts — the CMR-2
// steer-timeout fix needed lines and the app.ts 800-line cap is exhausted (P-FE-MD-HISTORY used
// the LAST bump), so growth extracts per the established slice-11/appActions split pattern.
// Behavior byte-preserved from the app.ts originals: autoscroll fires only when the operator is
// already within thresholdPx of the bottom, so manual scrollback is never yanked (P-Y2-MA G3).
import type { ElementLike } from "../render.js";

type ScrollMetrics = { scrollTop: number; scrollHeight: number; clientHeight: number };

export function isNearBottom(scrollAreaEl: ElementLike, thresholdPx: number): boolean {
  const sc = scrollAreaEl as unknown as ScrollMetrics;
  const distance = sc.scrollHeight - (sc.scrollTop + sc.clientHeight);
  return distance <= thresholdPx;
}

export function scrollToBottomIfPinned(scrollAreaEl: ElementLike, thresholdPx: number): void {
  if (!isNearBottom(scrollAreaEl, thresholdPx)) return;
  const sc = scrollAreaEl as unknown as ScrollMetrics;
  sc.scrollTop = sc.scrollHeight - sc.clientHeight;
}
