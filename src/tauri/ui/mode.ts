export type AppMode = "manual" | "auto";

export const MODE_LABELS = {
  manual: "Manual",
  auto: "Auto",
} as const;

export function modeFromToggles(cronEnabled: boolean): AppMode {
  return cronEnabled ? "auto" : "manual";
}

export function togglesForMode(mode: AppMode): { cronEnabled: boolean; passiveEnabled: boolean } {
  return mode === "auto"
    ? { cronEnabled: true, passiveEnabled: false }
    : { cronEnabled: false, passiveEnabled: false };
}

export function statusForMode(mode: AppMode): { label: string; tone: string } {
  return mode === "auto" ? { label: "Working", tone: "working" } : { label: "Listening", tone: "listening" };
}
