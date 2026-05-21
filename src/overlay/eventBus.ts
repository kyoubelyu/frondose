import { appendFileSync } from "node:fs";
import path from "node:path";
import type { CdpHandle } from "../cdp/types.js";
import { getHomeBase } from "../persistence/paths.js";

/** P-55 + P-56b: overlay -> host event envelope. Runtime shape stays open.
 *
 * Known `event_type` discriminator values:
 * - "hello" (P-55): operator clicked the idle pill.
 * - "tool-call" (P-56b): the agent loop called a tool; payload includes toolName.
 * - "overlay-reconnected" (P-56b): a new overlay context was captured after an earlier one.
 */
export interface OverlayEvent {
  kind: "overlay-event";
  ts: number;
  event_type: string;
  t0: number;
  latency_ms: number;
}

type RawOverlayPayload = {
  type?: unknown;
  t0?: unknown;
};

export function appendOverlayEventRow(
  event: OverlayEvent,
  auditPath: string = path.join(getHomeBase(), ".mai", "agent", "audit.jsonl"),
): void {
  appendFileSync(auditPath, `${JSON.stringify(event)}\n`);
}

export function attachEventBus(client: CdpHandle, onEvent: (event: OverlayEvent) => void): () => void {
  const unsubscribe = client.Runtime.bindingCalled(({ name, payload }: { name: string; payload: string }) => {
    if (name !== "__maiPost") return;
    try {
      const raw = JSON.parse(payload) as RawOverlayPayload;
      if (typeof raw.type !== "string") return;
      const ts = Date.now();
      const t0 = typeof raw.t0 === "number" ? raw.t0 : ts;
      onEvent({
        kind: "overlay-event",
        ts,
        event_type: raw.type,
        t0,
        latency_ms: ts - t0,
      });
    } catch {
      return;
    }
  });
  return unsubscribe;
}
