// P-Y2.2a — facade. inject.ts hit the 800-line cap (was 725; the frondose reskin pushes past), so the
// bootstrap string moved to bootstrap.ts (+ bootstrapShell/bootstrapLegacy fragments) and the CDP host
// helpers to host.ts. Re-exported here so EVERY existing importer (serve/{turn,cron,passive,routes}.ts,
// linkedin/session.ts) and every `mock.module("…/inject.js")` test keeps resolving unchanged.
export { OVERLAY_BOOTSTRAP_JS } from "./bootstrap.js";
export { callInOverlay, installOverlay, subscribeContextId } from "./host.js";
