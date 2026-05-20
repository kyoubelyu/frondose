import chalk from "chalk";

const ARGS_TRUNCATE = 40;
const ERROR_TRUNCATE = 80;

const COLOR_ENABLED = !process.env.NO_COLOR && process.stdout.isTTY !== false;

const cyan = (s: string): string => (COLOR_ENABLED ? chalk.cyan(s) : s);
const green = (s: string): string => (COLOR_ENABLED ? chalk.green(s) : s);
const red = (s: string): string => (COLOR_ENABLED ? chalk.red(s) : s);

export function formatToolCallLine(tr: { toolName: string; args: unknown; result: unknown }): string {
  const argsPart = formatArgs(tr.args);
  const { ok, errMsg } = classifyResult(tr.result);
  const status = ok ? green("✓") : red(`✗ ${errMsg}`);
  return `${cyan(`⚙ ${tr.toolName}`)}${argsPart} → ${status}`;
}

export function formatArgs(args: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(args ?? {});
  } catch {
    return "(…)";
  }
  if (s === undefined) return "(…)";
  if (s === "{}") return "()";
  if (s.length > ARGS_TRUNCATE) return `(${s.slice(0, ARGS_TRUNCATE)}…)`;
  return `(${s})`;
}

export function classifyResult(result: unknown): { ok: boolean; errMsg: string } {
  if (result && typeof result === "object") {
    const r = result as { ok?: unknown; error?: unknown; message?: unknown };
    if (r.ok === false) {
      const e = typeof r.error === "string" ? r.error : typeof r.message === "string" ? r.message : "failed";
      return {
        ok: false,
        errMsg: e.length > ERROR_TRUNCATE ? `${e.slice(0, ERROR_TRUNCATE)}…` : e,
      };
    }
  }
  return { ok: true, errMsg: "" };
}
