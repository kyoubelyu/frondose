/**
 * `mai soul reset` subcommand + the shared free-axes prompt helper.
 *
 * The `mai soul {show,edit}` actions were removed in P-APP-11 stage (b1):
 *   - `show` (composed Soul band) and `edit` (open identity.json in $EDITOR) are
 *     app-covered (P-Y6 Settings soul-override field).
 *   - The operator-approved `$EDITOR` external editor launch site was removed with `edit`.
 * `reset` is retained: it re-picks the 4 free axes, and Settings exposes no freeAxes
 * control — it is the only post-bootstrap free-axes reset path.
 *
 * `promptFreeAxes` is also load-bearing on the agent first-run boot path:
 * src/cli/identity-init.ts (promptFreeAxesAndPersist) → src/cli/workerBoot.ts.
 */
import { createInterface } from "node:readline";
import { FREE_AXES, formatAxisOptionsForPrompt, freeAxesSchema } from "../../methodology/freeAxes.js";
import type { FreeAxesRecord } from "../../methodology/types.js";
import { applyIdentityPatch, identityRecordSchema, readIdentity, writeIdentity } from "../../persistence/identity.js";

export interface SoulSubcommandOpts {
  identityPath: string;
}

export async function runSoulSubcommand(action: "reset", opts: SoulSubcommandOpts): Promise<void> {
  if (action === "reset") return runSoulReset(opts);
  throw new Error(`Unknown soul action: ${action}`);
}

async function runSoulReset(opts: SoulSubcommandOpts): Promise<void> {
  const existing = readIdentity(opts.identityPath);
  if (!existing) {
    process.stderr.write(`[frondose] identity.json missing at ${opts.identityPath}. Run \`mai\` first to bootstrap.\n`);
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
  process.stdout.write("[frondose] freeAxes saved.\n");
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
