/**
 * P-3 LinkedIn primitives — internal-facing module.
 * Consumed by src/tools/linkedin/**. NOT re-exported from src/index.ts (G-P3.7).
 */

export type { Destination, FixedDestination } from "./destinations.js";
export { companyDestinationUrl, LINKEDIN_FIXED_DESTINATIONS, normalizeDestination } from "./destinations.js";
export type { CommandEnvelope } from "./envelope.js";
export { fail, failFromError, ok, withHint } from "./envelope.js";
export {
  AVAILABLE_SCOPES_BY_SURFACE,
  buildInspectSummary,
  CLICKABLE_ROLES,
  INPUT_ROLES,
  TEXT_ROLES,
} from "./inspectSummary.js";
export type { LabelResolveOpts } from "./labelResolver.js";
export { resolveByLabel } from "./labelResolver.js";
export { applyPacing } from "./pacing.js";
export { inferSurface, isLinkedInLoginUrl, LINKEDIN_APP_HOSTS } from "./scopeResolver.js";
export { createLinkedinSession } from "./session.js";
export { captureCurrentSurfaceContext } from "./snapshotCapture.js";
export type {
  ClientOrUnavailable,
  CurrentSurfaceContext,
  InspectSummary,
  LinkedInSurface,
  LinkedinSession,
  PacingResult,
  SnapshotEntry,
} from "./types.js";
export { inspectSummarySchema } from "./types.js";
export { assertUploadPathAllowed, resolveUploadAllowlist } from "./uploadAllowlist.js";
