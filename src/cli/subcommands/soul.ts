/**
 * `mai soul {show, edit, reset}` subcommand.
 *
 * Lint exemption note (per docs/phase-5-plan.md §2 nuance 4):
 *   The Biome `noRestrictedImports` `child_process` ban is configured under
 *   `**\/src/tools/**` only. This file lives at `src/cli/subcommands/soul.ts`,
 *   OUTSIDE the lint ban scope. `child_process.spawn` is permitted here for
 *   the `mai soul edit` subcommand's `$EDITOR` invocation.
 *   The no-bash boundary is preserved: tool implementations under src/tools/**
 *   still cannot use child_process; CLI subcommands (which the operator
 *   invokes directly, not the LLM) may.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { composeSoulBand } from "../../agent/systemPrompt/soul.js";
import { FREE_AXES, formatAxisOptionsForPrompt, freeAxesSchema } from "../../methodology/freeAxes.js";
import type { FreeAxesRecord } from "../../methodology/types.js";
import { applyIdentityPatch, identityRecordSchema, readIdentity, writeIdentity } from "../../persistence/identity.js";

export interface SoulSubcommandOpts {
  identityPath: string;
}

export async function runSoulSubcommand(action: "show" | "edit" | "reset", opts: SoulSubcommandOpts): Promise<void> {
  if (action === "show") return runSoulShow(opts);
  if (action === "edit") return runSoulEdit(opts);
  if (action === "reset") return runSoulReset(opts);
  throw new Error(`Unknown soul action: ${action}`);
}

function runSoulShow(opts: SoulSubcommandOpts): void {
  const identity = readIdentity(opts.identityPath);
  const composed = composeSoulBand(identity);
  process.stdout.write("\n=== Soul band (composed from identity.json) ===\n\n");
  process.stdout.write(composed);
  process.stdout.write("\n\n=== end Soul band ===\n");
}

async function runSoulEdit(opts: SoulSubcommandOpts): Promise<void> {
  if (!existsSync(opts.identityPath)) {
    process.stderr.write(`[mai] identity.json missing at ${opts.identityPath}. Run \`mai\` first to bootstrap.\n`);
    process.exit(1);
  }
  const editor = process.env.EDITOR || process.env.VISUAL || "vi";
  process.stdout.write(`Opening ${opts.identityPath} in ${editor}...\n`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(editor, [opts.identityPath], { stdio: "inherit" });
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${editor} exited with code ${code}`));
    });
    child.once("error", reject);
  });

  // Re-validate after editor exits.
  try {
    const reread = readIdentity(opts.identityPath);
    if (reread === null) {
      process.stderr.write("[mai] identity.json is invalid after edit. Re-run `mai soul edit` to fix.\n");
      process.exit(1);
    }
    const validation = identityRecordSchema.safeParse(reread);
    if (!validation.success) {
      process.stderr.write(`[mai] identity.json schema validation failed:\n${validation.error.message}\n`);
      process.exit(1);
    }
    process.stdout.write("[mai] identity.json saved + validated.\n");
  } catch (e) {
    process.stderr.write(`[mai] post-edit validation error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}

async function runSoulReset(opts: SoulSubcommandOpts): Promise<void> {
  const existing = readIdentity(opts.identityPath);
  if (!existing) {
    process.stderr.write(`[mai] identity.json missing at ${opts.identityPath}. Run \`mai\` first to bootstrap.\n`);
    process.exit(1);
  }

  process.stdout.write("\n=== mai soul reset — re-pick the 4 free axes ===\n");
  const axes = await promptFreeAxes();
  const patched = applyIdentityPatch(existing, { freeAxes: axes });
  const merged = identityRecordSchema.parse({
    ...patched,
    updatedAt: new Date().toISOString(),
  });
  writeIdentity(merged, opts.identityPath);
  process.stdout.write("[mai] freeAxes saved.\n");
}

/**
 * Prompt the operator for all 4 axis selections via readline.
 * Shared with src/cli/identity-init.ts (which calls this in first-run flow).
 *
 * Returns a FreeAxesRecord validated against freeAxesSchema (throws if invalid).
 */
export async function promptFreeAxes(): Promise<FreeAxesRecord> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const onClose = () => reject(new Error("axes prompt aborted (EOF)"));
      rl.once("close", onClose);
      rl.question(q, (answer) => {
        rl.removeListener("close", onClose);
        resolve(answer);
      });
    });

  try {
    const collected: Record<string, string> = {};
    for (const axisKey of ["pain_chain_lean", "lead_role", "discovery_lean", "story_shape"] as const) {
      // biome-ignore lint/style/noNonNullAssertion: 4 axis keys are statically populated in FREE_AXES.
      const axis = FREE_AXES[axisKey]!;
      process.stdout.write(formatAxisOptionsForPrompt(axisKey));
      process.stdout.write("\n");
      while (true) {
        const answer = (await ask(`Pick a number for ${axis.name} (Enter for default '${axis.defaultPick}'): `)).trim();
        if (!answer) {
          collected[axisKey] = axis.defaultPick;
          break;
        }
        const n = parseInt(answer, 10);
        if (Number.isInteger(n) && n >= 1 && n <= axis.options.length) {
          // biome-ignore lint/style/noNonNullAssertion: range-checked above.
          collected[axisKey] = axis.options[n - 1]!.key;
          break;
        }
        process.stdout.write(`  → invalid pick. Enter 1..${axis.options.length} or press Enter for default.\n`);
      }
    }
    return freeAxesSchema.parse(collected);
  } finally {
    rl.close();
  }
}
