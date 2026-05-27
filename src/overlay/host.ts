import type { CdpHandle } from "../cdp/types.js";
import { OVERLAY_BOOTSTRAP_JS } from "./bootstrap.js";

const APP_SIDECAR_OWNER = "frondose-app";
const DEFAULT_OVERLAY_OWNER = "frondose-serve";
const OVERLAY_VERSION = "p-app-4-overlay-v1";

export async function installOverlay(client: CdpHandle): Promise<string> {
  await client.Runtime.enable();
  await client.Page.enable();
  await client.Runtime.addBinding({ name: "__maiPost" });
  const passiveEnabled = (process.env.MAI_PASSIVE_SUGGEST ?? "on").toLowerCase() !== "off";
  const overlayOwner = process.env.MAI_SIDECAR_OWNER === APP_SIDECAR_OWNER ? APP_SIDECAR_OWNER : DEFAULT_OVERLAY_OWNER;
  const substituted = OVERLAY_BOOTSTRAP_JS.replace(/__MAI_PASSIVE_ENABLED__/g, JSON.stringify(passiveEnabled))
    .replace(/__MAI_OVERLAY_OWNER__/g, JSON.stringify(overlayOwner))
    .replace(/__MAI_OVERLAY_VERSION__/g, JSON.stringify(OVERLAY_VERSION));
  if (substituted.includes("__MAI_OVERLAY_OWNER__") || substituted.includes("__MAI_OVERLAY_VERSION__")) {
    throw new Error("unresolved overlay owner/version placeholder");
  }
  const { identifier } = await client.Page.addScriptToEvaluateOnNewDocument({
    source: substituted,
    worldName: "mai-overlay",
    runImmediately: true,
  });
  return identifier;
}

interface OverlayExecutionContext {
  id: number;
  name?: string;
  auxData?: {
    frameId?: string;
  };
}

/** P-56b: subscribe to the isolated overlay execution context. */
export async function subscribeContextId(
  client: CdpHandle,
  onContext: (contextId: number) => void,
): Promise<() => void> {
  const { frameTree } = await client.Page.getFrameTree();
  const mainFrameId = typeof frameTree?.frame?.id === "string" ? frameTree.frame.id : undefined;
  // top-frame context fires first due to runImmediately, so filtering by frameId after getFrameTree resolves is safe in practice.
  return client.Runtime.executionContextCreated(({ context }: { context: OverlayExecutionContext }) => {
    if (context.name !== "mai-overlay") return;
    if (mainFrameId !== undefined && context.auxData?.frameId !== mainFrameId) return;
    onContext(context.id);
  });
}

/**
 * P-56b: call a function inside the captured isolated overlay execution context.
 *
 * Best-effort + non-throwing BY DESIGN. The captured executionContextId goes stale
 * whenever the page navigates: Chrome destroys the old context before
 * executionContextCreated fires for the new document, so a call landing in that
 * window rejects with "Cannot find context with specified id". Because the agent
 * navigates LinkedIn constantly and every call site is fire-and-forget
 * (`void callInOverlay(...)`), an un-caught reject became an unhandled rejection that
 * flooded ~/.mai/agent/logs/crash.log (and is a silent-failure defect per CLAUDE.md).
 * This is a COSMETIC in-page overlay update (the Tauri shell renders from SSE, not
 * this), so swallowing is correct: the overlay re-evaluates on the new document and
 * subsequent calls use the refreshed contextId (state.overlayContextId is updated by
 * subscribeContextId's executionContextCreated listener).
 */
export async function callInOverlay(client: CdpHandle, contextId: number, functionDeclaration: string): Promise<void> {
  try {
    await client.Runtime.callFunctionOn({
      executionContextId: contextId,
      functionDeclaration,
      silent: true,
    });
  } catch {
    // Stale/destroyed overlay context during navigation — expected, benign, swallowed.
  }
}
