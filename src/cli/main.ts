#!/usr/bin/env node
import { existsSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CoreMessage } from "ai";
import { Command } from "commander";
import { resolveModel } from "../agent/modelResolver.js";
import { BOUNDARY_PLACEHOLDER } from "../agent/systemPrompt/boundary.js";
import { CHECKPOINT_PLACEHOLDER } from "../agent/systemPrompt/checkpoint.js";
import { composeSystemPrompt } from "../agent/systemPrompt/compose.js";
import { composeSoulBand } from "../agent/systemPrompt/soul.js";
import { createLinkedinSession } from "../linkedin/index.js";
import type { FreeAxesRecord } from "../methodology/types.js";
import {
  applyIdentityPatch,
  type IdentityRecord,
  identityRecordSchema,
  readIdentity,
  writeIdentity,
} from "../persistence/identity.js";
import { continueRecent, loadMessages } from "../persistence/session.js";
import { makeAllTools } from "../tools/index.js";
import { loadDotenv } from "./env.js";
import { runIdentityBootstrap } from "./identity-init.js";
import { runOneShot, runRepl } from "./repl.js";
import { promptFreeAxes, runSoulSubcommand } from "./subcommands/soul.js";

interface CliOpts {
  model?: string;
  prompt?: string;
  newSession: boolean;
  cwd: string;
  resetIdentity: boolean;
}

/**
 * Prompt the operator for the 4 free axes via readline; persist into identity.json.
 * Caller (`main()` body, only-when-freeAxes-absent path) ensures this runs only once
 * per binary invocation. Reuses §6.7's `promptFreeAxes` for the readline loop +
 * freeAxesSchema validation; adds the persist step here.
 *
 * Wrapper-here over substitution with `runSoulSubcommand("reset", …)` because the
 * reset subcommand prints a "=== mai soul reset — re-pick the 4 free axes ===" header
 * — wrong UX for the FIRST-time-after-bootstrap path. This wrapper runs the prompts
 * silently after identity bootstrap, no "reset" framing.
 */
async function promptFreeAxesAndPersist(identityPath: string): Promise<void> {
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

async function main(): Promise<void> {
  // CRITICAL: load .env BEFORE any code reads process.env (modelResolver, persistence).
  loadDotenv(process.cwd());

  // P-3 env reads (CDP layer): port + profile dir.
  // (v0.3-fix1: the prior eager-Chrome-skip env-var is no longer read here — Chrome
  // now boots lazily on first LinkedIn-tool invocation, so the opt-out is meaningless.
  // The env var stays documented as DEPRECATED in CLAUDE.md until v0.4 removes it.)
  const cdpPort = process.env.MAI_CDP_PORT ? parseInt(process.env.MAI_CDP_PORT, 10) : 9222;
  const profileDir = process.env.MAI_PROFILE_DIR ?? path.join(os.homedir(), ".mai", "agent", "chrome-profile");

  // P-4 env reads (persistence layer): memory DB + identity JSON paths.
  const memoryDbPath = process.env.MAI_MEMORY_DB_PATH ?? path.join(os.homedir(), ".mai", "agent", "memory.sqlite");
  const identityPath = process.env.MAI_IDENTITY_PATH ?? path.join(os.homedir(), ".mai", "agent", "identity.json");

  const program = new Command();
  program
    .name("mai")
    .description("LinkedIn autonomous agent")
    .version("0.3.1")
    .option("--model <spec>", "LLM model spec (provider:modelId); overrides MAI_MODEL")
    .option("--prompt <text>", "one-shot prompt; exits after response")
    .option("--new-session", "start a fresh session (discard prior context)", false)
    .option("--cwd <dir>", "working directory for session storage", process.cwd())
    .option("--reset-identity", "delete identity.json and re-run first-run bootstrap", false)
    // P-5 Step 5a (FAILURE-1 fix): Commander v12 requires a root .action() handler whenever
    // any subcommand is registered, otherwise root-level invocations like `mai --prompt "..."`
    // fall through to the usage screen and exit 1. The full REPL / one-shot body lives here.
    .action(async () => {
      const opts = program.opts<CliOpts>();

      // P-4: identity-init bootstrap (must run BEFORE Chrome boot — readline owns stdin).
      if (opts.resetIdentity && existsSync(identityPath)) unlinkSync(identityPath);
      if (!existsSync(identityPath)) {
        await runIdentityBootstrap(identityPath);
      }

      // P-5: axes-prompt-or-default (rev-2 §4 migration semantics). If identity.json exists
      // but lacks freeAxes (pre-P-5 record), trigger axes prompt on interactive REPL; silent
      // default + stderr nudge for non-TTY/--prompt.
      const initialIdentity = readIdentity(identityPath);
      if (initialIdentity && !initialIdentity.freeAxes) {
        if (process.stdin.isTTY && !opts.prompt) {
          await promptFreeAxesAndPersist(identityPath);
          // (re-read happens below via finalIdentity)
        } else {
          process.stderr.write(
            "[mai] freeAxes not yet picked — using methodology defaults. Run `mai soul reset` to set them.\n",
          );
        }
      }

      const model = resolveModel({ cli: opts.model });

      // P-5: Soul band composed from final identity record (re-read after potential axes prompt).
      const finalIdentity: IdentityRecord | null = readIdentity(identityPath);
      const system = composeSystemPrompt({
        boundary: BOUNDARY_PLACEHOLDER,
        soul: composeSoulBand(finalIdentity),
        checkpoint: CHECKPOINT_PLACEHOLDER,
      });
      const sessionFile = continueRecent(opts.cwd, { newSession: opts.newSession });
      const messages: CoreMessage[] = loadMessages(sessionFile);

      // v0.3-fix1: lazy LinkedinSession factory — captures launch options only; Chrome
      // boots on first session.getOrInitClient() call inside any LinkedIn tool's execute.
      // Memory + identity tools work without Chrome.
      const linkedinSession = createLinkedinSession({ port: cdpPort, profileDir });
      const tools = makeAllTools(linkedinSession, { memoryDbPath, identityPath });

      if (typeof opts.prompt === "string" && opts.prompt.length > 0) {
        await runOneShot({ model, system, messages, tools, sessionFile, prompt: opts.prompt });
        process.exit(0);
      }

      await runRepl({ model, system, messages, tools, sessionFile });
    });

  // P-5: `mai soul <action>` subcommand. Short-circuits via process.exit(0) — never
  // falls through to REPL/one-shot dispatch.
  program
    .command("soul <action>")
    .description(
      "Soul-band controls: 'show' prints composed Soul; 'edit' opens identity.json in $EDITOR; 'reset' re-prompts the 4 free axes.",
    )
    .action(async (action: string) => {
      if (action !== "show" && action !== "edit" && action !== "reset") {
        process.stderr.write(`[mai] unknown soul action: ${action}. Use show / edit / reset.\n`);
        process.exit(1);
      }
      await runSoulSubcommand(action, { identityPath });
      process.exit(0);
    });

  await program.parseAsync(process.argv);
  // No code after parseAsync — root + soul actions run themselves.
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
