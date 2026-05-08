import type { CdpHandle, WaitOptions, WaitState } from "./types.js";
import { WaitTimeoutError } from "./types.js";

const DEFAULT_TIMEOUT = 30000;
const DEFAULT_POLL = 500;

/** Wait for a frame URL matching a string substring or RegExp pattern. */
export async function waitForUrl(client: CdpHandle, pattern: string | RegExp, opts: WaitOptions = {}): Promise<void> {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
  return new Promise<void>((resolve, reject) => {
    const matches = (url: string): boolean => (typeof pattern === "string" ? url.includes(pattern) : pattern.test(url));
    let unsubscribe: (() => void) | undefined;
    const timer = setTimeout(() => {
      unsubscribe?.();
      reject(new WaitTimeoutError(`waitForUrl timeout after ${timeout}ms (pattern=${String(pattern)})`));
    }, timeout);
    unsubscribe = client.Page.frameNavigated((params: { frame: { url: string } }) => {
      if (matches(params.frame.url)) {
        clearTimeout(timer);
        unsubscribe?.();
        resolve();
      }
    });
  });
}

/** Wait for window.onload, OR for Page.lifecycleEvent name="networkIdle". */
export async function waitForLoad(client: CdpHandle, state: WaitState = "load", opts: WaitOptions = {}): Promise<void> {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
  if (state === "load") {
    return new Promise<void>((resolve, reject) => {
      let unsubscribe: (() => void) | undefined;
      const timer = setTimeout(() => {
        unsubscribe?.();
        reject(new WaitTimeoutError(`waitForLoad("load") timeout after ${timeout}ms`));
      }, timeout);
      unsubscribe = client.Page.loadEventFired(() => {
        clearTimeout(timer);
        unsubscribe?.();
        resolve();
      });
    });
  }
  // state === "networkidle"
  await client.Page.setLifecycleEventsEnabled({ enabled: true });
  return new Promise<void>((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    const timer = setTimeout(() => {
      unsubscribe?.();
      reject(new WaitTimeoutError(`waitForLoad("networkidle") timeout after ${timeout}ms`));
    }, timeout);
    unsubscribe = client.Page.lifecycleEvent((params: { name: string }) => {
      if (params.name === "networkIdle") {
        clearTimeout(timer);
        unsubscribe?.();
        resolve();
      }
    });
  });
}

/** Poll Runtime.evaluate until document.body.innerText.includes(text) is true. */
export async function waitForText(client: CdpHandle, text: string, opts: WaitOptions = {}): Promise<void> {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
  const pollInterval = opts.pollInterval ?? DEFAULT_POLL;
  const start = Date.now();
  const expression = `document.body.innerText.includes(${JSON.stringify(text)})`;
  // setTimeout-based loop (avoids overlap if Runtime.evaluate is slow).
  while (true) {
    const elapsed = Date.now() - start;
    if (elapsed >= timeout) {
      throw new WaitTimeoutError(`waitForText timeout after ${timeout}ms (text=${JSON.stringify(text)})`);
    }
    const r = await client.Runtime.evaluate({ expression, returnByValue: true });
    if (r.result?.value === true) return;
    await new Promise<void>((r2) => setTimeout(r2, pollInterval));
  }
}

/** Poll Runtime.evaluate (with awaitPromise) until expr evaluates truthy. */
export async function waitForFn(client: CdpHandle, expression: string, opts: WaitOptions = {}): Promise<void> {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
  const pollInterval = opts.pollInterval ?? DEFAULT_POLL;
  const start = Date.now();
  while (true) {
    const elapsed = Date.now() - start;
    if (elapsed >= timeout) {
      throw new WaitTimeoutError(`waitForFn timeout after ${timeout}ms (expression=${expression})`);
    }
    const r = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
    if (r.result?.value === true) return;
    await new Promise<void>((r2) => setTimeout(r2, pollInterval));
  }
}
