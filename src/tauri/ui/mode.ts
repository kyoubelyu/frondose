// P-SP-C: 3-mode model — "magical" is the passive-judgement mode that observes
// operator browsing, records raw_candidates, scores leads, and surfaces cards
// without firing outbound. Cron (cronEnabled) wins precedence over passive when
// both are true — operator has handed off autonomy; Auto mode covers it.
export type AppMode = "manual" | "magical" | "auto";

export const MODE_LABELS = {
  manual: "Manual",
  magical: "Magical",
  auto: "Auto",
} as const;

/** P-SP-C: derive the named mode from the two source-of-truth flags. Precedence:
 *  cronEnabled wins over passiveEnabled (cron = operator-pre-approved autonomy).
 *  Replaces the pre-P-SP-C single-arg `modeFromToggles(cronEnabled)` which could
 *  not distinguish "magical" (passive on, cron off) from "manual" (both off). */
export function modeFromState(flags: { cronEnabled: boolean; passiveEnabled: boolean }): AppMode {
  if (flags.cronEnabled) return "auto";
  if (flags.passiveEnabled) return "magical";
  return "manual";
}

export function togglesForMode(mode: AppMode): { cronEnabled: boolean; passiveEnabled: boolean } {
  if (mode === "auto") return { cronEnabled: true, passiveEnabled: false };
  if (mode === "magical") return { cronEnabled: false, passiveEnabled: true };
  return { cronEnabled: false, passiveEnabled: false };
}

export function statusForMode(mode: AppMode): { label: string; tone: string } {
  if (mode === "auto") return { label: "Working", tone: "working" };
  if (mode === "magical") return { label: "Observing", tone: "observing" };
  return { label: "Listening", tone: "listening" };
}
