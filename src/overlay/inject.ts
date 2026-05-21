import type { CdpHandle } from "../cdp/types.js";

/** P-56b: exported so host-side overlay helpers and tests can reference the exact bootstrap source. */
export const OVERLAY_BOOTSTRAP_JS = `
(function install() {
  if (window.top !== window.self) return;
  if (window.__maiBootstrapped) return;
  if (!document.documentElement) {
    document.addEventListener("DOMContentLoaded", install, {once: true});
    return;
  }

  const host = document.createElement('div');
  host.id = '__mai_root';
  host.style.cssText = 'all:initial; position:fixed; bottom:72px; right:16px; z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const pill = document.createElement('div');
  pill.style.cssText = 'background:#0a66c2; color:white; padding:8px 12px; border-radius:16px; font:14px/1.2 system-ui; cursor:pointer; box-shadow:0 2px 8px rgba(0,0,0,0.15);';
  pill.textContent = 'mai \\xb7 idle';
  shadow.appendChild(pill);

  document.documentElement.appendChild(host);
  window.__maiBootstrapped = true;

  new MutationObserver(() => {
    if (!document.documentElement.contains(host)) {
      document.documentElement.appendChild(host);
    }
  }).observe(document.documentElement, { childList: true });

  shadow.firstElementChild.addEventListener('click', () => {
    window.__maiPost(JSON.stringify({ type: 'hello', url: location.href, t0: Date.now() }));
  });

  var resetTimer = null;
  window.__maiUpdateTicker = function(text) {
    if (resetTimer) {
      clearTimeout(resetTimer);
      resetTimer = null;
    }
    pill.textContent = text;
    if (text === 'done') {
      resetTimer = setTimeout(function() {
        pill.textContent = 'mai \\xb7 idle';
        resetTimer = null;
      }, 5000);
    }
  };
})();
`.trim();

export async function installOverlay(client: CdpHandle): Promise<string> {
  await client.Runtime.enable();
  await client.Page.enable();
  await client.Runtime.addBinding({ name: "__maiPost" });
  const { identifier } = await client.Page.addScriptToEvaluateOnNewDocument({
    source: OVERLAY_BOOTSTRAP_JS,
    worldName: "mai-overlay",
    runImmediately: true,
  });
  return identifier;
}

/** P-56b: subscribe to the isolated overlay execution context. */
export function subscribeContextId(client: CdpHandle, onContext: (contextId: number) => void): () => void {
  return client.Runtime.executionContextCreated(({ context }: { context: { id: number; name?: string } }) => {
    if (context.name === "mai-overlay") onContext(context.id);
  });
}

/** P-56b: call a function inside the captured isolated overlay execution context. */
export async function callInOverlay(client: CdpHandle, contextId: number, functionDeclaration: string): Promise<void> {
  await client.Runtime.callFunctionOn({
    executionContextId: contextId,
    functionDeclaration,
    silent: true,
  });
}
