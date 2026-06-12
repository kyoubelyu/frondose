/**
 * P-13 D-3 / D-4 / D-5 / D-9: interactive-prompt foundation.
 *
 * Exports:
 *   - isInteractive(): TTY + env-flag detection (D-4)
 *   - sanitizePasted(value): strip bracketed-paste markers (D-9)
 *   - printNoninteractiveGuidance(cmd, args, exampleVal): D-5 3-line stderr template (N-1 fix Step 3b — extracted)
 *   - Prompter interface (D-3) — 10 methods (N-2 fix Step 3b)
 *   - realPrompter: canonical implementation calling @inquirer/prompts
 *   - is{Auth,Identity,Telegram,Soul}Configured() helpers for setup wizard checkbox defaults (D-6)
 *
 * No `child_process` import (lint-enforced under src/tools/**); this file is `src/cli/**`.
 */
import { existsSync } from "node:fs";
import { checkbox, input, confirm as inquirerConfirm, password, select } from "@inquirer/prompts";
import { frondoseEnv } from "../../env.js";
import { readAuth } from "../../persistence/auth.js";
import { DEFAULT_GITHUB_CONFIG_PATH, readGithubConfig } from "../../persistence/github.js";
import { readIdentity } from "../../persistence/identity.js";
import type { ScheduleRecord } from "../../persistence/schedule.js";
import { DEFAULT_SEARCH_CONFIG_PATH, readSearchConfig } from "../../persistence/search.js";
import type { SessionEntry } from "../../persistence/session.js";
import { readTelegramConfig } from "../../persistence/telegramConfig.js";

/** D-4: canonical TTY + env-flag gate. Strict `=== true` matches scout F-3. */
export function isInteractive(): boolean {
  return process.stdin.isTTY === true && frondoseEnv("NO_INTERACTIVE") !== "1";
}

/** D-9: strip ANSI bracketed-paste markers from any input/password return value.
 *  The control characters are intentional: matching \x1b (ESC) is the whole point. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI ESC matching is the regex's purpose
const BRACKETED_PASTE_RE = /\x1b\[200~|\x1b\[201~/g;
export function sanitizePasted(value: string): string {
  return value.replace(BRACKETED_PASTE_RE, "");
}

/**
 * D-5 + N-1 fix Step 3b: stderr 3-line guidance for non-interactive + missing-args path.
 * Canonical implementation; imported by every subcommand file + main.ts.
 */
export function printNoninteractiveGuidance(cmd: string, args: string, exampleVal: string): void {
  process.stderr.write(`[mai ${cmd}] requires ${args}.\n`);
  process.stderr.write(`  Non-interactive: mai ${cmd} ${exampleVal}\n`);
  process.stderr.write(`  Or run \`mai ${cmd}\` interactively in a terminal.\n`);
}

/** D-3: prompter DI interface — 10 methods (N-2 fix Step 3b). */
export interface Prompter {
  providerSelect(existing: string[]): Promise<string>;
  apiKeyInput(provider: string): Promise<string>;
  confirmDefault(provider: string): Promise<boolean>;
  sessionsSelect(sessions: SessionEntry[]): Promise<string>;
  schedulesSelect(jobs: ScheduleRecord[]): Promise<string | null>;
  telegramUserSelect(senders: Map<number, string>): Promise<number | null>;
  confirm(message: string, defaultValue?: boolean): Promise<boolean>;
  axisSelect(axisKey: string, choices: { key: string; meaning: string }[]): Promise<string>;
  /** D-7 fallback: manual user_id when getUpdates fails. Also used by C-1 sentinel for `auth set` new-provider. */
  input(message: string): Promise<string>;
  /** D-6 wizard top-level section picker. */
  checkboxSections(choices: { name: string; value: string; checked: boolean }[]): Promise<string[]>;
  /** P-21: model picker after auto-fetched `/v1/models` list. */
  modelSelect(models: string[]): Promise<string>;
}

export const realPrompter: Prompter = {
  async providerSelect(existing) {
    // C-1 Option A fix Step 3b: always include "(add new provider spec…)" sentinel so
    // an operator with existing providers can still add a new one via `auth set` interactive.
    // The sentinel value "__NEW__" is intercepted by auth.ts's `set` case to call
    // prompter.input() for an arbitrary spec string. The `remove` and `default` cases
    // treat the sentinel as a cancellation no-op.
    const choices = [
      ...existing.map((p) => ({ name: p, value: p })),
      { name: "(add new provider spec…)", value: "__NEW__" },
    ];
    return await select({
      message: "Select provider:",
      choices,
    });
  },
  async apiKeyInput(provider) {
    const raw = await password({ message: `${provider} API key:`, mask: "*" });
    return sanitizePasted(raw);
  },
  async confirmDefault(provider) {
    return await inquirerConfirm({ message: `Set ${provider} as default model?`, default: false });
  },
  async sessionsSelect(sessions) {
    const choices = sessions.map((s) => ({
      name: `${s.sessionId.slice(0, 8)}  ${new Date(s.mtimeMs).toLocaleDateString()}  "${(s.firstPrompt ?? "").slice(0, 40)}..."`,
      value: s.sessionId,
      description: `${s.messageCount} messages  ${s.cwdLabel ?? s.cwdHash}`,
    }));
    return await select({ message: "Select session to continue:", choices });
  },
  async schedulesSelect(jobs) {
    if (jobs.length === 0) return null;
    const choices = jobs.map((j) => ({
      name: `${j.id.slice(0, 8)}  ${j.type}  "${j.task.slice(0, 40)}"  next: ${j.nextRunAt}`,
      value: j.id,
    }));
    return await select({ message: "Select job to remove:", choices });
  },
  async telegramUserSelect(senders) {
    if (senders.size === 0) return null;
    const choices = [...senders.entries()].map(([id, label]) => ({ name: label, value: id }));
    return await select({ message: "Select Telegram sender:", choices });
  },
  async confirm(message, defaultValue = false) {
    return await inquirerConfirm({ message, default: defaultValue });
  },
  async axisSelect(axisKey, choices) {
    return await select({
      message: `Methodology axis: ${axisKey}`,
      choices: choices.map((c) => ({ name: `${c.key} — ${c.meaning}`, value: c.key })),
    });
  },
  async input(message) {
    const raw = await input({ message });
    return sanitizePasted(raw);
  },
  async checkboxSections(choices) {
    return await checkbox({
      message: "Which sections to configure? (space=toggle, enter=confirm)",
      choices,
    });
  },
  async modelSelect(models) {
    const choices = models.map((m) => ({ name: m, value: m }));
    return await select({
      message: "Select model:",
      choices,
      pageSize: 15,
    });
  },
};

/** D-6 wizard checkbox pre-check helpers. */
export function isAuthConfigured(authPath: string): boolean {
  const a = readAuth(authPath);
  return !!a && !!a.providers && Object.keys(a.providers).length > 0;
}
export function isIdentityConfigured(identityPath: string): boolean {
  return existsSync(identityPath) && readIdentity(identityPath) !== null;
}
export function isTelegramConfigured(tcPath: string): boolean {
  const cfg = readTelegramConfig(tcPath);
  return cfg.boundUserId !== null;
}
export function isSoulConfigured(identityPath: string): boolean {
  const rec = readIdentity(identityPath);
  return !!rec && !!rec.freeAxes;
}
export function isIntegrationsConfigured(ghPath?: string, searchPath?: string): boolean {
  const gh = readGithubConfig(ghPath ?? DEFAULT_GITHUB_CONFIG_PATH());
  const sc = readSearchConfig(searchPath ?? DEFAULT_SEARCH_CONFIG_PATH());
  return !!(gh.token || gh.repo || sc.braveApiKey || sc.tavilyApiKey);
}
