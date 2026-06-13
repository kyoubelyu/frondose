// F-REN-4a — data-dir migration. Boot-time, atomic, idempotent.
//
// On first boot of the new build, moves `<homeBase>/.mai` → `<homeBase>/.frondose`
// via inode rename (atomic when both sides are on the same filesystem; under
// `$HOME` they always are). Called from every Node entry point that operates
// on the operator's data dir, BEFORE any path read. Idempotent: a second call
// is a constant-time no-op. Multi-entrypoint safe (rename atomicity + existence
// re-check covers the parallel-boot race).
//
// The source `<homeBase>/.mai` is NEVER deleted unless `renameSync` succeeded,
// which by POSIX semantics means the destination is already emplaced. No
// copy-then-delete fallback — under same-volume $HOME the rename cannot
// produce a partial state.
//
// See docs/phase-fren-4a-plan.md §5 for the testable-behavior contract.
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";

export const DATA_DIR_NAME = ".frondose";
export const LEGACY_DATA_DIR_NAME = ".mai";

export type MigrationResult =
  | { moved: false; reason: "no_legacy" | "already_migrated" | "both_exist" | "rename_failed"; error?: string }
  | { moved: true; reason: "renamed" };

export function migrateDataDir(homeBase: string): MigrationResult {
  const legacy = join(homeBase, LEGACY_DATA_DIR_NAME);
  const target = join(homeBase, DATA_DIR_NAME);
  const legacyExists = existsSync(legacy);
  const targetExists = existsSync(target);

  if (!legacyExists && !targetExists) return { moved: false, reason: "no_legacy" };
  if (!legacyExists && targetExists) return { moved: false, reason: "already_migrated" };
  if (legacyExists && targetExists) {
    process.stderr.write(
      `[frondose] both ${legacy} and ${target} exist — preferring ${target}; ${legacy} is untouched.\n` +
        `  See docs/phase-fren-4a-runbook.md for the recommended cleanup.\n`,
    );
    return { moved: false, reason: "both_exist" };
  }

  // legacyExists && !targetExists — the actual migration.
  try {
    renameSync(legacy, target);
    process.stderr.write(`[frondose] migrated data dir ${legacy} → ${target}\n`);
    return { moved: true, reason: "renamed" };
  } catch (err) {
    // B-3 race-safe re-check: a concurrent boot may have ALREADY moved legacy → target
    // between our existsSync() calls above and our renameSync() throw. POSIX rename(2)
    // throws ENOENT on a vanished source, and Node's renameSync surfaces this verbatim.
    // If the post-throw filesystem state matches the success post-condition (legacy gone,
    // target present), the throw is a race-loser artifact, NOT a genuine failure. We
    // classify it as already_migrated so the entrypoint does NOT fail-close (B-2) on a
    // healthy concurrent boot. Only a state that diverges from the success post-condition
    // (legacy still present OR target still absent) is a genuine rename_failed.
    if (!existsSync(legacy) && existsSync(target)) {
      // Race-loser: silent success. No stderr noise — the winner already logged.
      return { moved: false, reason: "already_migrated" };
    }
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[frondose] FAILED to migrate ${legacy} → ${target}: ${msg}\n` +
        `  Your ${legacy} is UNCHANGED. See docs/phase-fren-4a-runbook.md for manual recovery.\n`,
    );
    return { moved: false, reason: "rename_failed", error: msg };
  }
}

// bootMigrateOrExit: B-1 / B-2 entrypoint policy. Run as the FIRST data-dir-
// touching statement in every Node entrypoint. On rename_failed (and ONLY
// rename_failed — B-3 already classified race-losers as already_migrated),
// exit the process before any subsequent code writes to ~/.frondose. The
// operator's ~/.mai is preserved by the migrator; the entrypoint's job is to
// refuse to boot a fresh empty profile alongside it.
export function bootMigrateOrExit(homeBase: string): void {
  const result = migrateDataDir(homeBase);
  if (!result.moved && result.reason === "rename_failed") {
    process.stderr.write(
      `[frondose] data-dir migration failed; refusing to boot a fresh profile.\n` +
        `  Your data is INTACT at ${homeBase}/${LEGACY_DATA_DIR_NAME}. See docs/phase-fren-4a-runbook.md.\n`,
    );
    process.exit(1);
  }
}
