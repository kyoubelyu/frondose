import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { compareVersions } from "../subcommands/update.js";

// §6.5: GC ───────────────────────────────────────────────────────────────────

export function gcOldReleases(releasesDir: string, keepLastN: number): void {
  if (!existsSync(releasesDir)) return;
  const entries = readdirSync(releasesDir)
    .filter((d) => d.startsWith("v") && existsSync(join(releasesDir, d)))
    .filter((d) => {
      try {
        return statSync(join(releasesDir, d)).isDirectory();
      } catch {
        return false;
      }
    });
  if (entries.length <= keepLastN) return;
  // Semver-aware sort (handles v0.4.9 vs v0.4.10 correctly).
  const sorted = entries.slice().sort((a, b) => compareVersions(a, b));
  const toRemove = sorted.slice(0, sorted.length - keepLastN);
  for (const d of toRemove) {
    try {
      rmSync(join(releasesDir, d), { recursive: true, force: true });
    } catch {
      // GC is best-effort; ignore permission errors etc.
    }
  }
}
