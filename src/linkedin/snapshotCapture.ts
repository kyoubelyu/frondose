import type { CdpClient } from "../cdp/client.js";
import { inferSurface } from "./scopeResolver.js";
import type { CurrentSurfaceContext, SnapshotEntry } from "./types.js";

/** Capture the current surface: AX snapshot + URL routing + (messaging) opener synthesis. */
export async function captureCurrentSurfaceContext(client: CdpClient): Promise<CurrentSurfaceContext> {
  await client.snapshot();
  const refMap = client.currentRefMap;
  const entries: SnapshotEntry[] = Object.entries(refMap).map(([key, e]) => ({
    ref: `@${key}`,
    role: e.role,
    name: e.name ?? "",
  }));

  const pageUrl = await client.getCurrentUrl();
  const surface = inferSurface(pageUrl);

  if (surface === "messaging" || surface === "messaging-thread") {
    const synth = await synthesizeMessagingConversationOpeners(client);
    entries.push(...synth);
  }

  return { pageUrl, surface, activeLayer: "page", entries };
}

/** Synthesize `mr1, mr2, ...` refs for messaging conversation list items. */
async function synthesizeMessagingConversationOpeners(client: CdpClient): Promise<SnapshotEntry[]> {
  // Selector per mai-linkedin reference; OQ-P3.2 risk — verify in P-3 live smoke.
  const nodeIds = await client.querySelectorAll("li[class*='msg-conversation-listitem']");
  const out: SnapshotEntry[] = [];
  let i = 0;
  for (const nodeId of nodeIds) {
    i++;
    const ref = `@mr${i}`;
    let label = "";
    try {
      const attrs = await client.handle.DOM.getAttributes({ nodeId });
      const arr = (attrs?.attributes ?? []) as string[];
      // Interleaved [name0, value0, name1, value1, ...] per CDP spec.
      for (let k = 0; k < arr.length - 1; k += 2) {
        if (arr[k] === "aria-label") {
          label = arr[k + 1] ?? "";
          break;
        }
      }
    } catch {
      // best-effort; continue with empty label
    }
    out.push({ ref, role: "messagingConversationOpener", name: label });
  }
  return out;
}
