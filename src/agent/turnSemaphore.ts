/**
 * P-11 / D-3: Promise-chain mutex serializing operator + cron + telegram turns.
 * No deadlock by design (no recursive acquisition — verified scout V-12).
 * No external dep.
 */
export class TurnLock {
  private chain: Promise<void> = Promise.resolve();

  /** Serialize fn behind any prior queued fns. Returns fn's resolved value (or rejects with its error). */
  run<T>(fn: () => Promise<T>): Promise<T> {
    let outerResolve!: (v: T) => void;
    let outerReject!: (e: unknown) => void;
    const outer = new Promise<T>((res, rej) => {
      outerResolve = res;
      outerReject = rej;
    });
    this.chain = this.chain.then(async () => {
      try {
        outerResolve(await fn());
      } catch (e) {
        outerReject(e);
      }
    });
    return outer;
  }
}
