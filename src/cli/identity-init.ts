import { dirname, join } from "node:path";
import { detectAnyModelKey, resolveModel } from "../agent/modelResolver.js";
import { type IdentityRecord, readIdentity } from "../persistence/identity.js";
import { runBootstrapAgent } from "./bootstrap-agent.js";

const NO_KEY_ERROR = `[mai] No LLM API key found. The identity bootstrap requires an LLM to guide
      the conversation.

To set up a key, run ONE of the following first:

  mai auth set anthropic:claude-sonnet-4-5 --key YOUR_ANTHROPIC_KEY
  mai auth set openai:gpt-4o --key YOUR_OPENAI_KEY
  mai auth set openai:deepseek-chat --key YOUR_DEEPSEEK_KEY \\
      --base-url https://api.deepseek.com

Then re-run \`mai identity init\` (or just \`mai\` for the first-time flow).
`;

/**
 * Run the LLM-led identity bootstrap. Backward-compat with P-4's signature so
 * src/cli/main.ts's existing first-run call site is unchanged.
 *
 * Internally:
 *   1. Chicken-and-egg guard via detectAnyModelKey — fails loudly + exit 1 if no key.
 *   2. Resolves a LanguageModel via the precedence chain (factory > CLI > env > auth.json default > anthropic:claude-sonnet-4-5).
 *   3. Calls runBootstrapAgent with the resolved model + identity/wip paths.
 *   4. Re-reads identity.json to return the fresh IdentityRecord (or throws if bootstrap aborted without finalize).
 */
export async function runIdentityBootstrap(identityPath: string): Promise<IdentityRecord> {
  if (!detectAnyModelKey()) {
    process.stderr.write(NO_KEY_ERROR);
    process.exit(1);
  }
  const wipPath = join(dirname(identityPath), ".identity-wip.json");
  const model = resolveModel({});
  await runBootstrapAgent({ identityPath, wipPath, model });
  const record = readIdentity(identityPath);
  if (!record) {
    throw new Error("Identity bootstrap completed but identity.json is missing or invalid. Check stderr for details.");
  }
  return record;
}
