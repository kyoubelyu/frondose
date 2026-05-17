/** P-32: typed loader for the in-house CGEvent N-API addon (native/cgevent).
 *  Built by `npm run build:native` (node-gyp) → build/Release/cgevent.node. */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface CgEvent {
  moveMouse(x: number, y: number): void;
  mouseClick(): void;
  scrollWheel(dx: number, dy: number): void;
  keyEvent(keyCode: number, down: boolean, flags: number): void;
  unicodeType(text: string): void;
  getMousePos(): { x: number; y: number };
  getScreenSize(): { width: number; height: number };
  isAccessibilityTrusted(): boolean;
}

let cached: CgEvent | undefined;

/** Load the addon. Throws a clear Error when the .node is absent (e.g. build:native
 *  was skipped / non-darwin) — callers (resolveInputMode) catch and downgrade. */
export function loadCgEvent(): CgEvent {
  if (cached) return cached;
  const here = dirname(fileURLToPath(import.meta.url)); // dist/native
  // dist/native → repo root → build/Release/cgevent.node
  const candidates = [
    join(here, "..", "..", "build", "Release", "cgevent.node"),
    join(here, "..", "..", "prebuilds", "darwin-arm64", "cgevent.node"),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      "[mai] cgevent native addon not built — run `npm run build:native` (Xcode CLT required). " +
        "Hardware input mode is unavailable; falling back to CDP.",
    );
  }
  cached = createRequire(import.meta.url)(found) as CgEvent;
  return cached;
}
