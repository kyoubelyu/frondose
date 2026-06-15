import type { CdpClient } from "../../cdp/client.js";

const REGION_TAG_JS = `(() => {
  document.querySelectorAll('[data-mai-rg-aside="1"]').forEach(el => el.removeAttribute('data-mai-rg-aside'));
  const ASIDE_SEL = "aside, [role='complementary']";
  const NODE_SEL = [
    'button',
    'a[href]',
    'a[role="button"]',
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="option"]',
    'input',
    'textarea',
    'select',
    '[tabindex]:not([tabindex="-1"])',
    '[contenteditable="true"]'
  ].join(',');
  const seen = new Set();
  const tag = (el) => {
    if (seen.has(el)) return;
    seen.add(el);
    el.setAttribute('data-mai-rg-aside', '1');
  };
  for (const aside of document.querySelectorAll(ASIDE_SEL)) {
    if (aside.matches(NODE_SEL)) tag(aside);
    aside.querySelectorAll(NODE_SEL).forEach(tag);
  }
  return {};
})()`;

const REGION_TAG_CLEANUP_JS = `(() => {
  document.querySelectorAll('[data-mai-rg-aside]').forEach(el => el.removeAttribute('data-mai-rg-aside'));
  return {};
})()`;

export async function tagAsideClickables(client: CdpClient): Promise<Set<number>> {
  try {
    const evalResult = await client.handle.Runtime.evaluate({
      expression: REGION_TAG_JS,
      awaitPromise: false,
      returnByValue: true,
    });
    if (evalResult?.exceptionDetails) throw new Error("region tag evaluate failed");
    const nodeIds = await client.querySelectorAll('[data-mai-rg-aside="1"]');
    const out = new Set<number>();
    for (const nodeId of nodeIds) {
      const desc = await client.handle.DOM.describeNode({ nodeId });
      const backendNodeId = desc.node?.backendNodeId;
      if (typeof backendNodeId === "number") out.add(backendNodeId);
    }
    return out;
  } catch {
    return new Set();
  } finally {
    try {
      await client.handle.Runtime.evaluate({
        expression: REGION_TAG_CLEANUP_JS,
        awaitPromise: false,
        returnByValue: true,
      });
    } catch {
      // Best-effort cleanup must not block snapshot capture.
    }
  }
}
