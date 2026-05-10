import type { LanguageModel } from "ai";
import chalk from "chalk";
import type { TokenBudget } from "../agent/tokenBudget.js";

const BAR_WIDTH = 25;
const FILL = "█";
const EMPTY = "░";

/**
 * rev-3 D-18: top-of-terminal status bar. Persistent ANSI line at row 0.
 * No-op when not connected to a TTY stdout (preserves test-stub output).
 */
export class StatusLine {
  private readonly out: NodeJS.WritableStream;
  private readonly enabled: boolean;
  private last: { budget: TokenBudget; model: LanguageModel; sessionId: string } | null = null;

  constructor(out: NodeJS.WritableStream) {
    this.out = out;
    this.enabled = out === process.stdout && process.stdout.isTTY === true;
  }

  update(budget: TokenBudget, model: LanguageModel, sessionId: string): void {
    if (!this.enabled) return;
    this.last = { budget, model, sessionId };
    this.redraw();
  }

  redraw(): void {
    if (!this.enabled || this.last == null) return;
    const { budget, model, sessionId } = this.last;
    const cols = process.stdout.columns ?? 80;
    const line = formatLine(budget, model, sessionId, cols);
    // \x1b[s save, \x1b[H home (row 0 col 0), \x1b[2K clear line, write, \x1b[u restore.
    this.out.write(`\x1b[s\x1b[H\x1b[2K${line}\x1b[u`);
  }

  handleResize(): void {
    this.redraw();
  }

  dispose(): void {
    if (!this.enabled) return;
    this.out.write("\x1b[s\x1b[H\x1b[2K\x1b[u");
  }
}

function formatLine(budget: TokenBudget, model: LanguageModel, sessionId: string, cols: number): string {
  const last = budget.lastPromptTokens;
  const w = budget.contextWindow;
  const ratio = w > 0 ? Math.min(1, last / w) : 0;
  const filled = Math.round(ratio * BAR_WIDTH);
  const bar = FILL.repeat(filled) + EMPTY.repeat(BAR_WIDTH - filled);
  const colored = ratio < 0.5 ? chalk.green(bar) : ratio < 0.75 ? chalk.yellow(bar) : chalk.red(bar);
  const pct = `${(ratio * 100).toFixed(1)}%`;
  const tokens = `${human(last)} / ${human(w)}`;
  const m = model as { provider?: string; modelId?: string };
  const modelLabel = `${m.provider ?? "?"}:${m.modelId ?? "?"}`;
  // Truncation order per D-18: drop session → model → tokens → keep [bar] %.
  const parts = [`[${colored}]`, pct, tokens, modelLabel, `session: ${sessionId}`];
  // Estimate the visible-width budget. ANSI escapes don't count toward width;
  // cols is wall-clock terminal columns. Use plain-text length for fit math.
  const plainParts = [`[${bar}]`, pct, tokens, modelLabel, `session: ${sessionId}`];
  while (parts.length > 2 && plainParts.join("  ").length > cols) {
    parts.pop();
    plainParts.pop();
  }
  return parts.join("  ");
}

function human(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}
