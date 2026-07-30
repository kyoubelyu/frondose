import assert from "node:assert/strict";

export function unexpectedTelegramRoute(url: string): never {
  throw new Error(`unexpected Telegram route: ${url}`);
}

export async function waitForPollerStopped(
  handle: { running: boolean },
  label: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (handle.running && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(handle.running, false, `${label} must reach running=false within ${timeoutMs}ms`);
}

export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
