/**
 * @kyoube/mai-agent — single-binary LinkedIn autonomous agent.
 *
 * PUBLISHED PRODUCT CONTRACT (per CLAUDE.md §1):
 *   - bin: mai → ./dist/cli/main.js
 *   - exports["."]: ./dist/index.js
 *   - 3-band system prompt composition order: Boundary → Soul → Checkpoint (invariant)
 *   - Tool inventory + schema (P-1: { echo }) is contract; renames need v1.0+ bump
 *   - On-disk session JSONL schema at ~/.mai/agent/sessions/<cwd-hash>/<ts>.jsonl
 *
 * Public API:
 *   - createMaiAgent(opts) — programmatic factory; returns MaiAgentController
 *   - re-exports of CoreMessage, LanguageModel, ToolSet from `ai` for caller convenience
 */

import type { CoreMessage, ToolSet } from "ai";
import { runAgentLoop } from "./agent/loop.js";
import { resolveModel } from "./agent/modelResolver.js";
import { BOUNDARY_PLACEHOLDER } from "./agent/systemPrompt/boundary.js";
import { CHECKPOINT_PLACEHOLDER } from "./agent/systemPrompt/checkpoint.js";
import { composeSystemPrompt } from "./agent/systemPrompt/compose.js";
import { composeSoulBand } from "./agent/systemPrompt/soul.js";
import { readIdentity } from "./persistence/identity.js";
import { appendMessages, continueRecent, loadMessages } from "./persistence/session.js";
import { tools as defaultTools } from "./tools/index.js";

export interface CreateMaiAgentOpts {
  /** Working directory for session storage. */
  cwd: string;
  /** Model spec; precedence: factory > CLI > MAI_MODEL env > ~/.mai/auth.json default > DEFAULT. */
  model?: string;
  /** True → fresh session; false → continueRecent. Default false. */
  newSession?: boolean;
  /** Override default tool set (P-1 ships `{ echo }`). Default: shipped tools. */
  tools?: ToolSet;
}

export interface MaiAgentController {
  /** Send one prompt; the loop appends user + response messages and persists them. */
  prompt(text: string): Promise<void>;
  /** Path to the session JSONL on disk (resumed or freshly created). */
  readonly sessionFile: string;
  /** Mutable in-memory messages array; reflects on-disk state plus current session. */
  readonly messages: CoreMessage[];
}

/**
 * Programmatic factory. Equivalent to launching `mai` without the CLI shell —
 * useful for tests and downstream callers.
 */
export function createMaiAgent(opts: CreateMaiAgentOpts): MaiAgentController {
  const model = resolveModel({ factory: opts.model });
  // P-5: Soul band composed from identity.json (or null fallback if absent).
  // The programmatic factory does not invoke runIdentityBootstrap; consumers can
  // call `mai` directly to bootstrap the record before using createMaiAgent.
  const soul = composeSoulBand(readIdentity());
  const system = composeSystemPrompt({
    boundary: BOUNDARY_PLACEHOLDER,
    soul,
    checkpoint: CHECKPOINT_PLACEHOLDER,
  });
  const sessionFile = continueRecent(opts.cwd, { newSession: opts.newSession });
  const messages: CoreMessage[] = loadMessages(sessionFile);
  const toolSet = opts.tools ?? defaultTools;

  return {
    sessionFile,
    messages,
    async prompt(text: string): Promise<void> {
      const turnStart = messages.length;
      messages.push({ role: "user", content: text });
      await runAgentLoop({ model, system, messages, tools: toolSet });
      appendMessages(sessionFile, messages.slice(turnStart));
    },
  };
}

export type { CoreMessage, LanguageModel, ToolSet } from "ai";
// P-6: re-export ControlSignals + audit writer surface for downstream consumers.
export { type AuditEntry, makeAuditWriter } from "./persistence/audit.js";
export type { ControlSignals } from "./tools/index.js";
