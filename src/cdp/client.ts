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

  /** Close the underlying CDP WebSocket (does NOT kill Chrome). */
  async close(): Promise<void> {
    await this.client.close();
  }
}
