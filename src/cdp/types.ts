/**
 * P-2 CDP layer — shared types.
 *
 * `chrome-remote-interface` ships no TypeScript types; rather than declaring an
 * ambient module globally, we contain `any` here in src/cdp/.
 */
// biome-ignore lint/suspicious/noExplicitAny: chrome-remote-interface has no types; any contained to src/cdp/
export type CdpHandle = any;

/** A single element ref from a snapshot. */
export interface ElementRef {
  /** Accessibility tree node id. */
  axNodeId: string;
  /** DOM backend node id (used by Input/DOM commands). */
  backendNodeId: number;
  /** ARIA role (e.g. "button", "link"). */
  role: string;
  /** Accessible name (e.g. button label). May be undefined. */
  name?: string;
}

/** Map of ref id (`e1`, `e2`, ...) → ElementRef. */
export type RefMap = Record<string, ElementRef>;

/** Result of a snapshot. */
export interface Snapshot {
  /** Human-readable tree string: `- <role> "<name>" [ref=@e1]\n...`. */
  tree: string;
  /** Map of ref id → element data. */
  refs: RefMap;
}

// biome-ignore lint/suspicious/noEmptyInterface: reserved for future filters per plan §6.4 line 480
export interface SnapshotOptions {
  /** Reserved for future filters. P-2 ignores. */
}

export interface WaitOptions {
  /** ms; default 30000. */
  timeout?: number;
  /** ms; default 500 (poll-based waits only). */
  pollInterval?: number;
}

/**
 * Aliases reserved for waitForText / waitForFn so future enhancements can
 * diverge without breaking imports. Currently identical to WaitOptions.
 * (Per guardian critic CONCERN-MR-2: required for `index.ts` re-export.)
 */
export type WaitTextOptions = WaitOptions;
export type WaitFnOptions = WaitOptions;

export type WaitState = "load" | "networkidle";

/** Discriminated union for `CdpClient.waitFor(opts)`. */
export type WaitForOpts =
  | ({ kind: "url"; pattern: string | RegExp } & WaitOptions)
  | ({ kind: "load"; state: WaitState } & WaitOptions)
  | ({ kind: "text"; text: string } & WaitOptions)
  | ({ kind: "fn"; expression: string } & WaitOptions);

export interface ScreenshotOptions {
  format?: "jpeg" | "png" | "webp";
  /** 0–100, jpeg only. */
  quality?: number;
}

export interface ChromeLaunchOptions {
  /** CDP port. Default 9222. */
  port?: number;
  /** Persistent user-data-dir. Default ~/.mai/agent/chrome-profile. */
  profileDir?: string;
  /** Extra flags appended to chrome-launcher's defaults. */
  chromeFlags?: string[];
}

export interface ChromeHandle {
  /** Actual port assigned (matches launch.port or CDP probe target). */
  port: number;
  /** True if THIS call spawned Chrome; false if it reused an existing instance. */
  launched: boolean;
  /** Defined only when `launched === true`. Calls chrome-launcher's kill(). */
  kill?: () => Promise<void>;
}

/** Thrown by waitFor* primitives on timeout. */
export class WaitTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WaitTimeoutError";
  }
}
