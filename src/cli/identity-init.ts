import { dirname, join } from "node:path";
import type { LanguageModel } from "ai";
import { detectAnyModelKey, resolveModel } from "../agent/modelResolver.js";
import type { FreeAxesRecord } from "../methodology/types.js";
import {
  applyIdentityPatch,
  type IdentityRecord,
  identityRecordSchema,
  readIdentity,
  writeIdentity,
} from "../persistence/identity.js";
import { runBootstrapAgent } from "./bootstrap-agent.js";
import { promptFreeAxes } from "./subcommands/soul.js";

const NO_KEY_ERROR = `[mai] No LLM API key found. The identity bootstrap requires an LLM to guide
      the conversation.

To set up a key, run ONE of the following first:

  mai auth set https://api.deepseek.com/v1 --key YOUR_DEEPSEEK_KEY \\
      --model-id deepseek-v4-flash --name deepseek --default
  mai auth set https://llm.example/v1 --key YOUR_CUSTOM_KEY \\
      --model-id your-model --name custom --default

Then re-run \`mai identity init\` (or just \`mai\` for the first-time flow).
`;

/**
 * Run the LLM-led identity bootstrap. Backward-compat with P-4's signature so
 * src/cli/main.ts's existing first-run call site is unchanged.
 *
 * Internally:
 *   1. Chicken-and-egg guard via detectAnyModelKey — fails loudly + exit 1 if no key.
 *      SKIPPED when opts.modelFactory provided (P-11 D-10 test-injection seam).
 *   2. Resolves a LanguageModel via the precedence chain (factory > CLI > env > auth.json default > deepseek:deepseek-v4-flash).
 *      SKIPPED when opts.modelFactory provided — its return value is used directly.
 *   3. Calls runBootstrapAgent with the resolved model + identity/wip paths.
 *   4. Re-reads identity.json to return the fresh IdentityRecord (or throws if bootstrap aborted without finalize).
 *
 * P-11 D-10: `opts.modelFactory` is the test-injection seam that fixes T-Identity4
 * hanging on real DeepSeek calls under Tailscale+Clash networks. Production code
 * paths (no opts) are byte-identical to pre-P-11 behavior.
 */
export async function runIdentityBootstrap(
  identityPath: string,
  opts?: { modelFactory?: () => LanguageModel },
): Promise<IdentityRecord> {
  const wipPath = join(dirname(identityPath), ".identity-wip.json");
  let model: LanguageModel;
  if (opts?.modelFactory) {
    model = opts.modelFactory();
  } else {
    if (!detectAnyModelKey()) {
      process.stderr.write(NO_KEY_ERROR);
      process.exit(1);
    }
    model = resolveModel({});
  }
  await runBootstrapAgent({ identityPath, wipPath, model });
  const record = readIdentity(identityPath);
  if (!record) {
    throw new Error("Identity bootstrap completed but identity.json is missing or invalid. Check stderr for details.");
  }
  return record;
}

/**
 * Prompt the operator for the 4 free axes via readline; persist into identity.json.
 * Called only when identity.json exists but freeAxes is absent (pre-P-5 record).
 */
export async function promptFreeAxesAndPersist(identityPath: string): Promise<void> {
  const existing = readIdentity(identityPath);
  if (!existing) {
    process.stderr.write("[mai] identity.json missing during axes-prompt — skipping (operator must re-run mai).\n");
    return;
  }
  process.stdout.write(
    "\n=== Pick your 4 methodology habit axes (one-time setup; can be re-rolled via `mai soul reset`) ===\n",
  );
  const axes: FreeAxesRecord = await promptFreeAxes();
  const patched = applyIdentityPatch(existing, { freeAxes: axes });
  const merged = identityRecordSchema.parse({
    ...patched,
    updatedAt: new Date().toISOString(),
  });
  writeIdentity(merged, identityPath);
  process.stdout.write("[mai] freeAxes saved.\n");
}
