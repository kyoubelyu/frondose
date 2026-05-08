import readline from "node:readline";
import type { CoreMessage, LanguageModel, StepResult, ToolSet } from "ai";
import { runAgentLoop } from "../agent/loop.js";
import { appendMessages } from "../persistence/session.js";

export interface ReplOpts {
  model: LanguageModel;
  system: string;
  /** Mutable; loop appends per turn. Loaded from session file at boot. */
  messages: CoreMessage[];
  tools: ToolSet;
  /** Path to the session JSONL file; new messages are appended after each turn. */
  sessionFile: string;
  /** Test injection. Defaults to process.stdout. */
  out?: NodeJS.WritableStream;
  /** Test injection. Defaults to process.stdin. */
  in_?: NodeJS.ReadableStream;
  /** P-6: REPL between-turn abort check; main.ts owns the controller. */
  abortController?: AbortController;
  /** P-6: passed through to runAgentLoop. */
  abortSignal?: AbortSignal;
  /** P-6: Vercel onStepFinish hook (e.g. audit writer). */
  onStepFinish?: (step: StepResult<ToolSet>) => Promise<void> | void;
}

export async function runRepl(opts: ReplOpts): Promise<void> {
  const out = opts.out ?? process.stdout;
  const inputStream = opts.in_ ?? process.stdin;
  // Auto-detect TTY (per guardian critic CONCERN-3): true for real operator
  // session (line-editing UX); false for test-injected non-TTY streams.
  const isTty = inputStream === process.stdin && process.stdin.isTTY === true;
  const rl = readline.createInterface({ input: inputStream, output: out, terminal: isTty });
  out.write("mai-agent ready. type a prompt; Ctrl-C exits.\n> ");
  for await (const line of rl) {
    // P-6: between-turn stop check — if a prior turn's stop tool aborted, exit the loop.
    if (opts.abortController?.signal.aborted) break;
    const text = line.trim();
    if (!text) {
      out.write("> ");
      continue;
    }
    const turnStart = opts.messages.length;
    opts.messages.push({ role: "user", content: text });
    await runAgentLoop({
      model: opts.model,
      system: opts.system,
      messages: opts.messages,
      tools: opts.tools,
      onText: (delta) => out.write(delta),
      abortSignal: opts.abortSignal,
      onStepFinish: opts.onStepFinish,
    });
    out.write("\n");
    appendMessages(opts.sessionFile, opts.messages.slice(turnStart));
    if (opts.abortController?.signal.aborted) break;
    out.write("> ");
  }
}

/** One-shot mode: send one prompt, drain, persist, return. */
export async function runOneShot(opts: ReplOpts & { prompt: string }): Promise<void> {
  const out = opts.out ?? process.stdout;
  const turnStart = opts.messages.length;
  opts.messages.push({ role: "user", content: opts.prompt });
  await runAgentLoop({
    model: opts.model,
    system: opts.system,
    messages: opts.messages,
    tools: opts.tools,
    onText: (delta) => out.write(delta),
    abortSignal: opts.abortSignal,
    onStepFinish: opts.onStepFinish,
  });
  out.write("\n");
  appendMessages(opts.sessionFile, opts.messages.slice(turnStart));
}
