#!/usr/bin/env node
import type { CoreMessage } from "ai";
import { Command } from "commander";
import { resolveModel } from "../agent/modelResolver.js";
import { BOUNDARY_PLACEHOLDER } from "../agent/systemPrompt/boundary.js";
import { CHECKPOINT_PLACEHOLDER } from "../agent/systemPrompt/checkpoint.js";
import { composeSystemPrompt } from "../agent/systemPrompt/compose.js";
import { SOUL_PLACEHOLDER } from "../agent/systemPrompt/soul.js";
import { continueRecent, loadMessages } from "../persistence/session.js";
import { tools } from "../tools/index.js";
import { loadDotenv } from "./env.js";
import { runOneShot, runRepl } from "./repl.js";

interface CliOpts {
  model?: string;
  prompt?: string;
  newSession: boolean;
  cwd: string;
}

async function main(): Promise<void> {
  // CRITICAL: load .env BEFORE any code reads process.env (modelResolver, persistence).
  loadDotenv(process.cwd());

  const program = new Command();
  program
    .name("mai")
    .description("LinkedIn autonomous agent")
    .version("0.3.0-pre")
    .option("--model <spec>", "LLM model spec (provider:modelId); overrides MAI_MODEL")
    .option("--prompt <text>", "one-shot prompt; exits after response")
    .option("--new-session", "start a fresh session (discard prior context)", false)
    .option("--cwd <dir>", "working directory for session storage", process.cwd())
    .parse(process.argv);

  const opts = program.opts<CliOpts>();
  const model = resolveModel({ cli: opts.model });
  const system = composeSystemPrompt({
    boundary: BOUNDARY_PLACEHOLDER,
    soul: SOUL_PLACEHOLDER,
    checkpoint: CHECKPOINT_PLACEHOLDER,
  });
  const sessionFile = continueRecent(opts.cwd, { newSession: opts.newSession });
  const messages: CoreMessage[] = loadMessages(sessionFile);

  if (typeof opts.prompt === "string" && opts.prompt.length > 0) {
    await runOneShot({ model, system, messages, tools, sessionFile, prompt: opts.prompt });
    process.exit(0);
  }

  await runRepl({ model, system, messages, tools, sessionFile });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
