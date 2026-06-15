/**
 * P-13 Step 4a — shared mock prompter factory for interactive subcommand tests.
 *
 * Usage: const mp = makeMockPrompter({ overrides }) — returns an object
 * implementing the Prompter interface with pre-canned answers + call recording.
 *
 * NOTE: This file imports Prompter from _prompts.ts which does NOT EXIST at Step
 * 4a. The import will fail at runtime (tsx resolution) until builder Step 4b
 * creates src/cli/subcommands/_prompts.ts. This is the expected scaffold failure mode.
 */

import type { Prompter } from "../../../src/cli/subcommands/_prompts.js";

export interface MockPrompterCalls {
  providerSelect: string[][];
  apiKeyInput: string[][];
  confirmDefault: string[][];
  sessionsSelect: unknown[][];
  schedulesSelect: unknown[][];
  telegramUserSelect: unknown[][];
  confirm: unknown[][];
  axisSelect: unknown[][];
  input: string[][];
  checkboxSections: unknown[][];
}

export interface MockPrompterOverrides {
  providerSelect?: (existing: string[]) => Promise<string>;
  apiKeyInput?: (provider: string) => Promise<string>;
  confirmDefault?: (provider: string) => Promise<boolean>;
  sessionsSelect?: (sessions: unknown[]) => Promise<string>;
  schedulesSelect?: (jobs: unknown[]) => Promise<string | null>;
  telegramUserSelect?: (senders: Map<number, string>) => Promise<number | null>;
  confirm?: (message: string, defaultValue?: boolean) => Promise<boolean>;
  axisSelect?: (axisKey: string, choices: { key: string; meaning: string }[]) => Promise<string>;
  input?: (message: string) => Promise<string>;
  checkboxSections?: (choices: { name: string; value: string; checked: boolean }[]) => Promise<string[]>;
}

/**
 * Build a mock prompter that records all invocations.
 * Override individual methods via the overrides parameter.
 */
export function makeMockPrompter(overrides: MockPrompterOverrides = {}): Prompter & { calls: MockPrompterCalls } {
  const calls: MockPrompterCalls = {
    providerSelect: [],
    apiKeyInput: [],
    confirmDefault: [],
    sessionsSelect: [],
    schedulesSelect: [],
    telegramUserSelect: [],
    confirm: [],
    axisSelect: [],
    input: [],
    checkboxSections: [],
  };

  const mock: Prompter & { calls: MockPrompterCalls } = {
    calls,
    async providerSelect(existing: string[]): Promise<string> {
      calls.providerSelect.push([...existing]);
      if (overrides.providerSelect) return overrides.providerSelect(existing);
      return "anthropic:claude-sonnet-4-5";
    },
    async apiKeyInput(provider: string): Promise<string> {
      calls.apiKeyInput.push([provider]);
      if (overrides.apiKeyInput) return overrides.apiKeyInput(provider);
      return "sk-mock-test-key";
    },
    async confirmDefault(provider: string): Promise<boolean> {
      calls.confirmDefault.push([provider]);
      if (overrides.confirmDefault) return overrides.confirmDefault(provider);
      return false;
    },
    async sessionsSelect(sessions: unknown[]): Promise<string> {
      calls.sessionsSelect.push([...sessions]);
      if (overrides.sessionsSelect) return overrides.sessionsSelect(sessions);
      return "mock-session-id";
    },
    async schedulesSelect(jobs: unknown[]): Promise<string | null> {
      calls.schedulesSelect.push([...jobs]);
      if (overrides.schedulesSelect) return overrides.schedulesSelect(jobs);
      return null;
    },
    async telegramUserSelect(senders: Map<number, string>): Promise<number | null> {
      calls.telegramUserSelect.push([senders]);
      if (overrides.telegramUserSelect) return overrides.telegramUserSelect(senders);
      return null;
    },
    async confirm(message: string, defaultValue?: boolean): Promise<boolean> {
      calls.confirm.push([message, defaultValue]);
      if (overrides.confirm) return overrides.confirm(message, defaultValue);
      return false;
    },
    async axisSelect(axisKey: string, choices: { key: string; meaning: string }[]): Promise<string> {
      calls.axisSelect.push([axisKey, ...choices]);
      if (overrides.axisSelect) return overrides.axisSelect(axisKey, choices);
      return choices[0]?.key ?? "default";
    },
    async input(message: string): Promise<string> {
      calls.input.push([message]);
      if (overrides.input) return overrides.input(message);
      return "mock-input-value";
    },
    async checkboxSections(choices: { name: string; value: string; checked: boolean }[]): Promise<string[]> {
      calls.checkboxSections.push([...choices]);
      if (overrides.checkboxSections) return overrides.checkboxSections(choices);
      return choices.filter((c) => c.checked).map((c) => c.value);
    },
  };

  return mock;
}

/** Stub process.stdin.isTTY + MAI_NO_INTERACTIVE for interactive-path tests. */
export function stubInteractive(tty: boolean, noInteractiveFlag?: string): () => void {
  const savedIsTTY = (process.stdin as { isTTY?: boolean }).isTTY;
  const savedFlag = process.env.FRONDOSE_NO_INTERACTIVE;
  (process.stdin as { isTTY?: boolean }).isTTY = tty ? true : undefined;
  if (noInteractiveFlag !== undefined) {
    process.env.FRONDOSE_NO_INTERACTIVE = noInteractiveFlag;
  } else {
    delete process.env.FRONDOSE_NO_INTERACTIVE;
  }
  return () => {
    (process.stdin as { isTTY?: boolean }).isTTY = savedIsTTY;
    if (savedFlag !== undefined) process.env.FRONDOSE_NO_INTERACTIVE = savedFlag;
    else delete process.env.FRONDOSE_NO_INTERACTIVE;
  };
}

/** Stub process.exit to capture exit code; restores original on cleanup. */
export function stubProcessExit(): { exitCode: number | undefined; restore: () => void } {
  const state: { exitCode: number | undefined } = { exitCode: undefined };
  const origExit = process.exit.bind(process);
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  (process as any).exit = (code: number) => {
    state.exitCode = code;
    throw new Error(`__mock_exit_${code}`);
  };
  return {
    restore: () => {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process as any).exit = origExit;
    },
    get exitCode() {
      return state.exitCode;
    },
  };
}

/**
 * Capture stdout writes during async fn; returns captured string.
 *
 * Write-through mode: also forwards every write to the real stdout so that
 * node:test's internal IPC protocol (binary msgpack messages sent over stdout
 * from the test subprocess to the parent reporter) is never disrupted. Without
 * write-through, tests that run long operations (e.g., the 2s CDP timeout in
 * runStatusSubcommand) swallow IPC messages for subsequently-registered suites,
 * causing those suites to vanish from the reporter output even though they run.
 */
export async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  // biome-ignore lint/suspicious/noExplicitAny: test mock — write-through to preserve node:test IPC
  (process.stdout as any).write = (chunk: string | Buffer, encoding?: unknown, cb?: unknown): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    // Forward to real stdout (node:test IPC must flow through)
    return (orig as (...args: unknown[]) => boolean)(chunk, encoding, cb);
  };
  try {
    await fn();
  } finally {
    // biome-ignore lint/suspicious/noExplicitAny: restore
    (process.stdout as any).write = orig;
  }
  return chunks.join("");
}

/**
 * Capture stderr writes during async fn; returns captured string.
 *
 * Write-through mode: also forwards to real stderr. This ensures console output
 * from production code remains visible in test logs while also being assertable.
 */
export async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  // biome-ignore lint/suspicious/noExplicitAny: test mock — write-through for visibility
  (process.stderr as any).write = (chunk: string | Buffer, encoding?: unknown, cb?: unknown): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    // Forward to real stderr
    return (orig as (...args: unknown[]) => boolean)(chunk, encoding, cb);
  };
  try {
    await fn();
  } finally {
    // biome-ignore lint/suspicious/noExplicitAny: restore
    (process.stderr as any).write = orig;
  }
  return chunks.join("");
}
