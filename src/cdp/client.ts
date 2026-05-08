// @ts-expect-error chrome-remote-interface ships no types; any-bleed contained via CdpHandle in types.ts (plan R-P2-01)
import CDP from "chrome-remote-interface";
import { getSnapshot } from "./snapshot.js";
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

/** Quad-array center: chrome-launcher Quad: [x0,y0,x1,y1,x2,y2,x3,y3]. */
function center(border: number[]): { x: number; y: number } {
  // top-left + bottom-right midpoint
  const x0 = border[0] ?? 0;
  const y0 = border[1] ?? 0;
  const x2 = border[4] ?? 0;
  const y2 = border[5] ?? 0;
  return { x: (x0 + x2) / 2, y: (y0 + y2) / 2 };
}

/** Typed wrapper around chrome-remote-interface's dynamic CDP client. */
export class CdpClient {
  private readonly client: CdpHandle;
  private refMap: RefMap = {};

  private constructor(client: CdpHandle) {
    this.client = client;
  }

  /** Connect to a Chrome on the given port (default page target). */
  static async connect(port: number): Promise<CdpClient> {
    const client = await CDP({ port });
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

  async navigate(url: string, waitUntil?: WaitState): Promise<void> {
    await this.client.Page.enable();
    const r = await this.client.Page.navigate({ url });
    if (r.errorText) throw new Error(`navigate failed: ${r.errorText}`);
    await waitForLoad(this.client, waitUntil ?? "load");
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
      const doc = await this.client.DOM.getDocument({ depth: 0 });
      const r = await this.client.DOM.querySelectorAll({
        nodeId: doc.root.nodeId,
        selector: selectorOrRef,
      });
      const first = r.nodeIds?.[0];
      if (typeof first !== "number") throw new Error(`clickAt: selector ${selectorOrRef} matched no element`);
      nodeId = first;
    }
    const arg = backendNodeId !== undefined ? { backendNodeId } : { nodeId };
    const box = await this.client.DOM.getBoxModel(arg);
    const { x, y } = center(box.model.border);
    await this.client.Input.dispatchMouseEvent({ type: "mouseMoved", x, y });
    await this.client.Input.dispatchMouseEvent({
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await this.client.Input.dispatchMouseEvent({
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }

  async typeAt(selectorOrRef: string, text: string): Promise<void> {
    await this.clickAt(selectorOrRef);
    await this.client.Input.insertText({ text });
  }

  async pressKey(key: string): Promise<void> {
    await this.client.Input.dispatchKeyEvent({ type: "keyDown", key });
    await this.client.Input.dispatchKeyEvent({ type: "keyUp", key });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.client.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(`evaluate threw: ${r.exceptionDetails.text ?? "unknown"}`);
    }
    return r.result?.value as T;
  }

  async screenshot(opts: ScreenshotOptions = {}): Promise<string> {
    const r = await this.client.Page.captureScreenshot({
      format: opts.format ?? "png",
      quality: opts.quality,
    });
    return r.data as string;
  }

  async reload(): Promise<void> {
    await this.client.Page.reload({});
  }

  async closeTab(): Promise<void> {
    await this.client.Page.close();
  }

  async closeBrowser(): Promise<void> {
    await this.client.Browser.close();
  }

  async snapshot(opts?: SnapshotOptions): Promise<Snapshot> {
    const result = await getSnapshot(this.client, opts);
    this.refMap = result.refs;
    return result;
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

  /** Smooth scroll the page in a given direction. Window center is the gesture origin. */
  async scroll(direction: "up" | "down" | "left" | "right", amount: number): Promise<void> {
    const xDistance = direction === "left" ? -amount : direction === "right" ? amount : 0;
    const yDistance = direction === "up" ? -amount : direction === "down" ? amount : 0;
    const metrics = await this.client.Page.getLayoutMetrics();
    // visualViewport.{clientWidth,clientHeight} per Page.getLayoutMetrics shape (CDP v1).
    const w = metrics?.visualViewport?.clientWidth ?? metrics?.layoutViewport?.clientWidth ?? 1280;
    const h = metrics?.visualViewport?.clientHeight ?? metrics?.layoutViewport?.clientHeight ?? 800;
    await this.client.Input.synthesizeScrollGesture({
      x: Math.round(w / 2),
      y: Math.round(h / 2),
      xDistance,
      yDistance,
    });
  }

  /** Get the current page URL via Runtime.evaluate. */
  async getCurrentUrl(): Promise<string> {
    return this.evaluate<string>("window.location.href");
  }

  /** Run document-rooted querySelectorAll; return matching nodeIds. */
  async querySelectorAll(selector: string): Promise<number[]> {
    const doc = await this.client.DOM.getDocument({ depth: 0 });
    const r = await this.client.DOM.querySelectorAll({
      nodeId: doc.root.nodeId,
      selector,
    });
    return r.nodeIds ?? [];
  }

  /** Set files on a file input. Resolves backendNodeId → nodeId internally. */
  async setFileInputFiles(backendNodeId: number, files: string[]): Promise<void> {
    const nodeId = await this.resolveBackendToNodeId(backendNodeId);
    await this.client.DOM.setFileInputFiles({ nodeId, files });
  }

  /**
   * Internal: convert backendNodeId (from AX tree) to nodeId (for DOM commands).
   * Per validator FAIL-1 (`docs/phase-3-test.md` §6): the prior `DOM.resolveNode → DOM.requestNode`
   * chain produced `nodeId: 0` against real Chrome, breaking `setFileInputFiles`.
   * `DOM.describeNode({ backendNodeId })` returns the nodeId directly.
   */
  private async resolveBackendToNodeId(backendNodeId: number): Promise<number> {
    const desc = await this.client.DOM.describeNode({ backendNodeId });
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

  /** Close the underlying CDP WebSocket (does NOT kill Chrome). */
  async close(): Promise<void> {
    await this.client.close();
  }
}
