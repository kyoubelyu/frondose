// @ts-expect-error chrome-remote-interface ships no types; any-bleed contained via CdpHandle in types.ts (plan R-P2-01)
import CDP from "chrome-remote-interface";
import { waitForPageTarget } from "./launcher.js";
import { jitter, mouseCurve } from "./mouseRealism.js";
import { raceCdp } from "./raced.js";
import { getSnapshot } from "./snapshot.js";
import { createTurnAbortSignalOwner } from "./turnAbortSignalOwner.js";
import type {
  CdpHandle,
  RefMap,
  ScreenshotOptions,
  Snapshot,
  SnapshotOptions,
  WaitForOpts,
  WaitState,
} from "./types.js";
import { waitForFn, waitForLoad, waitForText, waitForUrl } from "./waitFor.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Quad-array center: chrome-launcher Quad: [x0,y0,x1,y1,x2,y2,x3,y3]. */
function center(border: number[]): { x: number; y: number } {
  // top-left + bottom-right midpoint
  const x0 = border[0] ?? 0;
  const y0 = border[1] ?? 0;
  const x2 = border[4] ?? 0;
  const y2 = border[5] ?? 0;
  return { x: (x0 + x2) / 2, y: (y0 + y2) / 2 };
}

/** P-Y2.3: border quad [x0,y0,x1,y1,x2,y2,x3,y3] → viewport box {x,y,w,h}. Pure (unit-tested T-Box.1). */
export function borderQuadToBox(border: number[]): { x: number; y: number; w: number; h: number } {
  const x0 = border[0] ?? 0;
  const y0 = border[1] ?? 0;
  const x1 = border[2] ?? 0;
  const y2 = border[5] ?? 0;
  return { x: x0, y: y0, w: x1 - x0, h: y2 - y0 };
}

/** [P-75 P-WEDGE-1] Per-CDP-call deadline. Set well above a healthy call (a heavy
 *  LinkedIn getFullAXTree is single-digit seconds; navigate's own load wait is the
 *  separate 30s waitForLoad timeout) so it never false-positives on a slow-but-live
 *  page, but finite so a hung call can never pend forever → the permanent-wedge fix.
 *  The turn abort signal (D-16 cap / D-27 silent-hang / operator abort) interrupts
 *  in-flight calls EARLIER when wired; this deadline is the unconditional backstop. */
const CDP_CALL_DEADLINE_MS = 45_000;

/** Typed wrapper around chrome-remote-interface's dynamic CDP client. */
export class CdpClient {
  private readonly client: CdpHandle;
  private refMap: RefMap = {};
  /** [P-62 F-1] Set ONLY by injectStealth(client) after Page.addScriptToEvaluateOnNewDocument
   *  registers STEALTH_INIT_SCRIPT on this target. navigate() asserts it before any nav. */
  private stealthInjected = false;
  /** [P-75 P-WEDGE-1] Turn-scoped abort signal. Set by the session at turn start
   *  (and applied to a client booted mid-turn), cleared at turn end. When present,
   *  raced CDP calls reject immediately on abort instead of waiting out the deadline. */
  private readonly turnSignalOwner = createTurnAbortSignalOwner();
  /** [P-AUTO-11 M4] Last screen point the synthetic pointer landed on. Initialized
   *  to (0,0); updated to the JITTERED landing after each completed clickAt (never
   *  on abort — the race rejects before the assignment). NOT reset on navigate(). */
  private lastPointerPos: { x: number; y: number } = { x: 0, y: 0 };

  private constructor(client: CdpHandle) {
    this.client = client;
  }

  /** [P-75 P-WEDGE-1] Wire/clear the current turn's abort signal. Idempotent; pass
   *  undefined to clear at turn end. */
  setTurnAbortSignal(signal?: AbortSignal): void {
    this.turnSignalOwner.set(signal);
  }

  clearTurnAbortSignal(owner: AbortSignal): void {
    this.turnSignalOwner.clear(owner);
  }

  /** [P-75 P-WEDGE-1] Race a raw CDP promise against the per-call deadline + the
   *  current turn abort signal. The single choke-point every hangable CDP call
   *  routes through, so no individual call can pend forever (the unattended wedge).
   *  Param/return are `any` to preserve the existing CdpHandle (=any, types.ts:8)
   *  bleed — a generic `<T>` would collapse the untyped CDP result to `unknown` and
   *  break every call site's property access. */
  // biome-ignore lint/suspicious/noExplicitAny: mirrors CdpHandle=any (types.ts:8); generic would force unknown at every call site.
  private race(p: Promise<any>, label: string): Promise<any> {
    return raceCdp(p, { label, deadlineMs: CDP_CALL_DEADLINE_MS, signal: this.turnSignalOwner.get() });
  }

  // biome-ignore lint/suspicious/noExplicitAny: mirrors CdpHandle=any (types.ts:8), like the private race().
  raceHandle(p: Promise<any>, label: string): Promise<any> {
    return this.race(p, label);
  }

  /** Connect to a Chrome on the given port (default page target). */
  static async connect(port: number): Promise<CdpClient> {
    // v0.3-fix1 B1: wait for an inspectable page target before connecting (resolves
    // the "No inspectable targets" race when Chrome's first tab is not yet listed).
    const target = await waitForPageTarget(port);
    const client = await CDP({ port, target });
    return new CdpClient(client);
  }

  /**
   * Test-only: build a CdpClient around an externally-supplied handle.
   * Used by mock tests to inject a fake CDP client without the network roundtrip.
   * @internal
   */
  static fromHandle(handle: CdpHandle): CdpClient {
    return new CdpClient(handle);
  }

  /** Underlying handle, exposed for advanced callers (P-3 may extend). */
  get handle(): CdpHandle {
    return this.client;
  }

  /** @internal — called by injectStealth() in src/cdp/stealth.ts after registration. */
  markStealthInjected(): void {
    this.stealthInjected = true;
  }

  /** @internal — used by injectStealth() for idempotency early-return + by tests/lifecycle guards. */
  isStealthInjected(): boolean {
    return this.stealthInjected;
  }

  async dispatchHumanLikeClickAtCoords(x: number, y: number): Promise<void> {
    // P-AUTO-11 (M4): human-shaped click - jittered target + curved path + press-dwell,
    // tracking lastPointerPos. Shared by clickAt and deterministic runtime post publish.
    const target = { x: jitter(x), y: jitter(y) };
    for (const p of mouseCurve(this.lastPointerPos, target)) {
      await this.race(this.client.Input.dispatchMouseEvent({ type: "mouseMoved", x: p.x, y: p.y }), "Input.mouseMoved");
      await sleep(2 + Math.random() * 6);
    }
    await this.race(
      this.client.Input.dispatchMouseEvent({
        type: "mousePressed",
        x: target.x,
        y: target.y,
        button: "left",
        clickCount: 1,
      }),
      "Input.mousePressed",
    );
    await sleep(40 + Math.random() * 80); // P-AUTO-11: 40-120ms human press-dwell
    await this.race(
      this.client.Input.dispatchMouseEvent({
        type: "mouseReleased",
        x: target.x,
        y: target.y,
        button: "left",
        clickCount: 1,
      }),
      "Input.mouseReleased",
    );
    // Race-safety: the serve path uses abort-then-replace (routes/agent.ts:21-24,58 - aborts the prior
    // turn then `void runOneTurn(...)` without awaiting), NOT TurnLock, so two clickAt on this shared
    // session CdpClient CAN briefly overlap on an explicit operator /agent/turn interruption (Auto/cron
    // turns are sequential and never race here). Benign because: this write runs ONLY on a fully-completed
    // click - an aborted click rejects at its next this.race(...) (signal.aborted) before reaching here,
    // so an interrupted click never writes lastPointerPos; JS is single-threaded so the plain reference
    // assignment cannot tear; and lastPointerPos is a best-effort stealth hint (next click's curve origin)
    // where a stale-but-plausible value is biometrically harmless, not a correctness or security issue.
    this.lastPointerPos = target;
  }

  private static isPreloadInviteUrl(url: string): boolean {
    try {
      const u = new URL(url);
      return u.hostname.endsWith("linkedin.com") && /\/preload\/custom-invite\/?$/i.test(u.pathname);
    } catch {
      return false;
    }
  }

  async navigate(url: string, waitUntil?: WaitState): Promise<void> {
    // [P-62 F-1] Structural invariant: stealth MUST be injected before any navigation on this
    // target, or `"webdriver" in navigator === true` exposure recurs (92-reconnect regression).
    if (!this.stealthInjected) {
      throw new Error("navigate: stealth not injected — call injectStealth(client) first");
    }
    await this.race(this.client.Page.enable(), "Page.enable");
    const r = await this.race(this.client.Page.navigate({ url }), "Page.navigate");
    if (r.errorText) throw new Error(`navigate failed: ${r.errorText}`);
    const isPreload = CdpClient.isPreloadInviteUrl(url);
    const effectiveWait: WaitState = isPreload ? "networkidle" : (waitUntil ?? "load");
    const waitOpts = isPreload ? { timeout: 60_000 } : undefined;
    await this.race(waitForLoad(this.client, effectiveWait, waitOpts), "waitForLoad");
  }

  /** [P-75 D-17] Verify that the AX node behind a ref still has the expected role/name.
   *  LinkedIn re-uses input elements across modal states (Connect overlay, New Message
   *  dialog): the backendNodeId stays the same but the aria-label flips ("Search
   *  recipients" → "Write a message…", or vice-versa). When click/type acts on a stale
   *  ref, the CDP dispatch still works on the (now-different-purpose) element and the
   *  message text ends up in the wrong field.
   *
   *  Returns: {matches, currentRole, currentName}. matches=true when the AX role+name
   *  at the backendNodeId STILL equal what inspect recorded. expected.name is compared
   *  case-insensitive after trim. Cheap (~10-20ms): one Accessibility.getPartialAXTree
   *  CDP roundtrip per action; click+type already issue several roundtrips so the
   *  overhead is negligible vs the silent-mis-targeting failure mode it prevents.
   */
  async verifyRef(
    refKey: string,
    expected: { role: string; name?: string },
  ): Promise<{ matches: boolean; currentRole?: string; currentName?: string }> {
    const entry = this.refMap[refKey];
    if (!entry) return { matches: false };
    try {
      const r = (await this.race(
        this.client.Accessibility.getPartialAXTree({
          backendNodeId: entry.backendNodeId,
          fetchRelatives: false,
        }),
        "Accessibility.getPartialAXTree",
      )) as { nodes?: Array<{ role?: { value?: string }; name?: { value?: string }; ignored?: boolean }> };
      const node = r.nodes?.find((n) => !n.ignored) ?? r.nodes?.[0];
      const currentRole = node?.role?.value;
      const currentName = node?.name?.value;
      if (!currentRole) return { matches: false, currentRole, currentName };
      const expectedName = (expected.name ?? "").trim().toLowerCase();
      const actualName = (currentName ?? "").trim().toLowerCase();
      const roleOk = currentRole === expected.role;
      const nameOk = expectedName.length === 0 || actualName === expectedName;
      return { matches: roleOk && nameOk, currentRole, currentName };
    } catch {
      return { matches: true }; // verification failed at AX layer; don't block legitimate action
    }
  }

  async clickAt(selectorOrRef: string): Promise<void> {
    let backendNodeId: number | undefined;
    let nodeId: number | undefined;
    if (selectorOrRef.startsWith("@")) {
      const refKey = selectorOrRef.slice(1);
      const entry = this.refMap[refKey];
      if (!entry) throw new Error(`clickAt: ref @${refKey} not found in current snapshot`);
      backendNodeId = entry.backendNodeId;
    } else {
      const doc = await this.race(this.client.DOM.getDocument({ depth: 0 }), "DOM.getDocument");
      const r = await this.race(
        this.client.DOM.querySelectorAll({
          nodeId: doc.root.nodeId,
          selector: selectorOrRef,
        }),
        "DOM.querySelectorAll",
      );
      const first = r.nodeIds?.[0];
      if (typeof first !== "number") throw new Error(`clickAt: selector ${selectorOrRef} matched no element`);
      nodeId = first;
    }
    const arg = backendNodeId !== undefined ? { backendNodeId } : { nodeId };
    await this.race(this.client.DOM.scrollIntoViewIfNeeded(arg), "DOM.scrollIntoViewIfNeeded");
    await sleep(60);
    const box = await this.race(this.client.DOM.getBoxModel(arg), "DOM.getBoxModel");
    const c = center(box.model.border);
    await this.dispatchHumanLikeClickAtCoords(c.x, c.y);
  }

  /** P-Y2.3: resolve an element's viewport box for the takeover highlight. Same resolution as clickAt
   *  (@ref → refMap backendNodeId, else selector → first nodeId) → DOM.getBoxModel border quad. */
  async getBox(selectorOrRef: string): Promise<{ x: number; y: number; w: number; h: number }> {
    let backendNodeId: number | undefined;
    let nodeId: number | undefined;
    if (selectorOrRef.startsWith("@")) {
      const refKey = selectorOrRef.slice(1);
      const entry = this.refMap[refKey];
      if (!entry) throw new Error(`getBox: ref @${refKey} not found in current snapshot`);
      backendNodeId = entry.backendNodeId;
    } else {
      const doc = await this.race(this.client.DOM.getDocument({ depth: 0 }), "DOM.getDocument");
      const r = await this.race(
        this.client.DOM.querySelectorAll({ nodeId: doc.root.nodeId, selector: selectorOrRef }),
        "DOM.querySelectorAll",
      );
      const first = r.nodeIds?.[0];
      if (typeof first !== "number") throw new Error(`getBox: selector ${selectorOrRef} matched no element`);
      nodeId = first;
    }
    const arg = backendNodeId !== undefined ? { backendNodeId } : { nodeId };
    const box = await this.race(this.client.DOM.getBoxModel(arg), "DOM.getBoxModel");
    return borderQuadToBox(box.model.border as number[]);
  }

  async typeAt(selectorOrRef: string, text: string): Promise<void> {
    await this.clickAt(selectorOrRef);
    await this.race(this.client.Input.insertText({ text }), "Input.insertText");
  }

  async pressKey(key: string): Promise<void> {
    await this.race(this.client.Input.dispatchKeyEvent({ type: "keyDown", key }), "Input.keyDown");
    await this.race(this.client.Input.dispatchKeyEvent({ type: "keyUp", key }), "Input.keyUp");
  }

  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.race(
      this.client.Runtime.evaluate({
        expression,
        returnByValue: true,
        awaitPromise: true,
      }),
      "Runtime.evaluate",
    );
    if (r.exceptionDetails) {
      throw new Error(`evaluate threw: ${r.exceptionDetails.text ?? "unknown"}`);
    }
    return r.result?.value as T;
  }

  async screenshot(opts: ScreenshotOptions = {}): Promise<string> {
    const r = await this.race(
      this.client.Page.captureScreenshot({
        format: opts.format ?? "png",
        quality: opts.quality,
      }),
      "Page.captureScreenshot",
    );
    return r.data as string;
  }

  async reload(): Promise<void> {
    await this.race(this.client.Page.reload({}), "Page.reload");
  }

  async closeTab(): Promise<void> {
    await this.race(this.client.Page.close(), "Page.close");
  }

  async closeBrowser(): Promise<void> {
    await this.race(this.client.Browser.close(), "Browser.close");
  }

  async snapshot(opts?: SnapshotOptions): Promise<Snapshot> {
    const result = await getSnapshot(this.client, opts, (p, label) => this.race(p, label));
    this.refMap = result.refs;
    return result;
  }

  /** [P-59 INSPECT-1] Merge synthesized overlay refs into the current snapshot's refMap so the agent
   *  can click overlay items (menuitems/dialog) that are ABSENT from the AX tree. Additive: does NOT
   *  clear the AX-derived refs (called right after snapshot() in captureCurrentSurfaceContext). */
  mergeRefs(extra: RefMap): void {
    Object.assign(this.refMap, extra);
  }

  async waitFor(opts: WaitForOpts): Promise<void> {
    switch (opts.kind) {
      case "url":
        return waitForUrl(this.client, opts.pattern, opts);
      case "load":
        return waitForLoad(this.client, opts.state, opts);
      case "text":
        return waitForText(this.client, opts.text, opts);
      case "fn":
        return waitForFn(this.client, opts.expression, opts);
    }
  }

  /** P-37 B3: page scroll via window.scrollBy. Replaces Input.synthesizeScrollGesture,
   *  which required the gesture origin inside the COMPOSITED viewport — it failed
   *  when Chrome was backgrounded and on Retina DPR=2. window.scrollBy is pure JS:
   *  no coordinates, no focus dependency, no DPR mismatch. */
  async scroll(direction: "up" | "down" | "left" | "right", amount: number): Promise<void> {
    const dx = direction === "left" ? -amount : direction === "right" ? amount : 0;
    const dy = direction === "up" ? -amount : direction === "down" ? amount : 0;
    await this.evaluate<void>(`window.scrollBy(${dx}, ${dy})`);
  }

  /** Get the current page URL via Runtime.evaluate. */
  async getCurrentUrl(): Promise<string> {
    return this.evaluate<string>("window.location.href");
  }

  /** Read an element's visible text via document.querySelector. */
  async getElementText(selector: string): Promise<string | null> {
    return this.evaluate<string | null>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? (el.innerText || el.textContent || null) : null; })()`,
    );
  }

  /** Read an input-like element's value via document.querySelector. */
  async getInputValue(selector: string): Promise<string | null> {
    return this.evaluate<string | null>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return (el != null && "value" in el) ? String(el.value) : null; })()`,
    );
  }

  /** Run document-rooted querySelectorAll; return matching nodeIds. */
  async querySelectorAll(selector: string): Promise<number[]> {
    const doc = await this.race(this.client.DOM.getDocument({ depth: 0 }), "DOM.getDocument");
    const r = await this.race(
      this.client.DOM.querySelectorAll({
        nodeId: doc.root.nodeId,
        selector,
      }),
      "DOM.querySelectorAll",
    );
    return r.nodeIds ?? [];
  }

  /** Set files on a file input. Resolves backendNodeId → nodeId internally. */
  async setFileInputFiles(backendNodeId: number, files: string[]): Promise<void> {
    const nodeId = await this.resolveBackendToNodeId(backendNodeId);
    await this.race(this.client.DOM.setFileInputFiles({ nodeId, files }), "DOM.setFileInputFiles");
  }

  /**
   * Internal: convert backendNodeId (from AX tree) to nodeId (for DOM commands).
   * Per validator FAIL-1 (`docs/phase-3-test.md` §6): the prior `DOM.resolveNode → DOM.requestNode`
   * chain produced `nodeId: 0` against real Chrome, breaking `setFileInputFiles`.
   * `DOM.describeNode({ backendNodeId })` returns the nodeId directly.
   */
  private async resolveBackendToNodeId(backendNodeId: number): Promise<number> {
    const desc = await this.race(this.client.DOM.describeNode({ backendNodeId }), "DOM.describeNode");
    const nodeId = desc?.node?.nodeId;
    if (typeof nodeId !== "number") {
      throw new Error(`resolveBackendToNodeId: describeNode returned no nodeId for backendNodeId=${backendNodeId}`);
    }
    return nodeId;
  }

  /**
   * Read-only view of the most-recent snapshot's RefMap. Empty until snapshot() runs.
   * Per guardian critic CONCERN-MR-2 path (a): named `currentRefMap` (NOT `refMap`) so
   * the existing private field `refMap` doesn't need renaming — preserves P-2 invariant
   * "no existing line touched" in B-1.
   */
  get currentRefMap(): Readonly<RefMap> {
    return this.refMap;
  }

  /** True if the underlying WebSocket is connected and ready. */
  isConnected(): boolean {
    try {
      const ws = this.client._ws;
      return ws !== null && ws !== undefined && ws.readyState === 1; // WebSocket.OPEN
    } catch {
      return false;
    }
  }

  /** P-28.5: clear ALL browser cookies (pre-login profile cleanup). */
  async clearBrowserCookies(): Promise<void> {
    await this.race(this.client.Network.enable(), "Network.enable");
    await this.race(this.client.Network.clearBrowserCookies(), "Network.clearBrowserCookies");
  }

  /** P-28.5: clear cookies + localStorage + IndexedDB + caches for one origin. */
  async clearOriginData(origin: string): Promise<void> {
    await this.race(
      this.client.Storage.clearDataForOrigin({ origin, storageTypes: "all" }),
      "Storage.clearDataForOrigin",
    );
  }

  /** Close the underlying CDP WebSocket (does NOT kill Chrome). */
  async close(): Promise<void> {
    await this.client.close();
  }
}
