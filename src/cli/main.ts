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
import { SOUL_PLACEHOLDER } from "../agent/systemPrompt/soul.js";
import { createLinkedinSession } from "../linkedin/index.js";
import { continueRecent, loadMessages } from "../persistence/session.js";
import { makeAllTools } from "../tools/index.js";
import { loadDotenv } from "./env.js";
import { runIdentityBootstrap } from "./identity-init.js";
import { runOneShot, runRepl } from "./repl.js";

interface CliOpts {
  model?: string;
  prompt?: string;
  newSession: boolean;
  cwd: string;
  resetIdentity: boolean;
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
    .version("0.3.0-pre")
    .option("--model <spec>", "LLM model spec (provider:modelId); overrides MAI_MODEL")
    .option("--prompt <text>", "one-shot prompt; exits after response")
    .option("--new-session", "start a fresh session (discard prior context)", false)
    .option("--cwd <dir>", "working directory for session storage", process.cwd())
    .option("--reset-identity", "delete identity.json and re-run first-run bootstrap", false)
    .parse(process.argv);

  const opts = program.opts<CliOpts>();

  // P-4: identity-init bootstrap (must run BEFORE Chrome boot — readline owns stdin).
  if (opts.resetIdentity && existsSync(identityPath)) unlinkSync(identityPath);
  if (!existsSync(identityPath)) {
    await runIdentityBootstrap(identityPath);
  }

  const model = resolveModel({ cli: opts.model });
  const system = composeSystemPrompt({
    boundary: BOUNDARY_PLACEHOLDER,
    soul: SOUL_PLACEHOLDER,
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
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
