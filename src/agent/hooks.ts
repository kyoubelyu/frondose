import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getHomeBase } from "../persistence/paths.js";

/**
 * P-9 D-10 / D-14: Hook runner. Loaded once at REPL boot. NO hot-reload.
 *
 * Lives in src/agent/ NOT src/tools/ — the child_process import is legal here
 * because the lint boundary is scoped to src/tools/** only. Tool wrappers (src/tools/
 * hookWrapper.ts) import this class as a TYPE only.
 */

const hookCommandSchema = z.object({
  type: z.literal("command"),
  command: z.string().min(1),
  timeout: z.number().int().positive().max(120_000).optional(),
});
const hookEntrySchema = z.object({
  matcher: z.string(),
  hooks: z.array(hookCommandSchema).min(1),
});
const hooksJsonSchema = z.object({
  hooks: z.object({
    PreToolUse: z.array(hookEntrySchema).optional(),
    PostToolUse: z.array(hookEntrySchema).optional(),
    Stop: z.array(hookEntrySchema).optional(),
  }),
});

type HooksJson = z.infer<typeof hooksJsonSchema>;
type HookEntry = z.infer<typeof hookEntrySchema>;

const DEFAULT_TIMEOUT_MS = 10_000;

export interface PreHookResult {
  blocked: boolean;
  message?: string;
}

export class HookRunner {
  private readonly hooksJson: HooksJson | null;
  private readonly matcherCache = new WeakMap<HookEntry, RegExp>();

  constructor(hooksJsonPath = path.join(getHomeBase(), ".mai", "agent", "hooks.json")) {
    this.hooksJson = loadHooksJson(hooksJsonPath);
  }

  async runPreToolUse(toolName: string, args: unknown, toolCallId: string): Promise<PreHookResult> {
    const entries = this.matchEntries("PreToolUse", toolName);
    for (const entry of entries) {
      for (const cmd of entry.hooks) {
        const result = await spawnHook(cmd.command, { toolName, toolCallId, args }, cmd.timeout ?? DEFAULT_TIMEOUT_MS);
        if (result.kind === "spawn-error" || result.kind === "timeout") {
          // D-3: PreToolUse spawn failure = conservative BLOCK.
          return { blocked: true, message: `PreToolUse hook unreachable: ${result.message}` };
        }
        if (result.exitCode === 2) {
          return { blocked: true, message: result.stderr || `PreToolUse hook blocked '${toolName}'.` };
        }
        if (result.exitCode !== 0) {
          // Non-blocking error → log + continue to next hook.
          process.stderr.write(`[frondose] PreToolUse '${toolName}' hook exit ${result.exitCode}: ${result.stderr}\n`);
        }
      }
    }
    return { blocked: false };
  }

  async runPostToolUse(toolName: string, args: unknown, result: unknown, toolCallId: string): Promise<void> {
    const entries = this.matchEntries("PostToolUse", toolName);
    for (const entry of entries) {
      for (const cmd of entry.hooks) {
        const r = await spawnHook(
          cmd.command,
          { toolName, toolCallId, args, result },
          cmd.timeout ?? DEFAULT_TIMEOUT_MS,
        );
        // D-4: PostToolUse spawn failure / non-zero = LOG + CONTINUE.
        if (r.kind !== "ok") {
          process.stderr.write(`[frondose] PostToolUse '${toolName}' hook ${r.kind}: ${r.message}\n`);
        } else if (r.exitCode !== 0) {
          process.stderr.write(`[frondose] PostToolUse '${toolName}' hook exit ${r.exitCode}: ${r.stderr}\n`);
        }
      }
    }
  }

  async runStop(payload: { reason?: string }): Promise<void> {
    const entries = this.matchEntries("Stop", "stop");
    for (const entry of entries) {
      for (const cmd of entry.hooks) {
        const r = await spawnHook(cmd.command, { event: "Stop", ...payload }, cmd.timeout ?? DEFAULT_TIMEOUT_MS);
        if (r.kind !== "ok") {
          process.stderr.write(`[frondose] Stop hook ${r.kind}: ${r.message}\n`);
        } else if (r.exitCode !== 0) {
          process.stderr.write(`[frondose] Stop hook exit ${r.exitCode}: ${r.stderr}\n`);
        }
      }
    }
  }

  private matchEntries(event: "PreToolUse" | "PostToolUse" | "Stop", toolName: string): HookEntry[] {
    const list = this.hooksJson?.hooks[event] ?? [];
    return list.filter((entry) => {
      let re = this.matcherCache.get(entry);
      if (!re) {
        try {
          re = entry.matcher === "" ? /.*/ : new RegExp(entry.matcher);
          this.matcherCache.set(entry, re);
        } catch {
          return false;
        }
      }
      return re.test(toolName);
    });
  }
}

type SpawnResult =
  | { kind: "ok"; exitCode: number; stdout: string; stderr: string }
  | { kind: "spawn-error"; message: string }
  | { kind: "timeout"; message: string };

function spawnHook(command: string, payload: unknown, timeoutMs: number): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("/bin/sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve({ kind: "spawn-error", message: e instanceof Error ? e.message : String(e) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (r: SpawnResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* noop */
      }
      settle({ kind: "timeout", message: `hook timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      settle({ kind: "spawn-error", message: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      settle({ kind: "ok", exitCode: code ?? -1, stdout, stderr });
    });
    try {
      child.stdin?.write(`${JSON.stringify(payload)}\n`);
      child.stdin?.end();
    } catch (e) {
      clearTimeout(timer);
      settle({ kind: "spawn-error", message: e instanceof Error ? e.message : String(e) });
    }
  });
}

function loadHooksJson(filePath: string): HooksJson | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const result = hooksJsonSchema.safeParse(parsed);
    if (!result.success) {
      process.stderr.write(
        `[frondose] hooks.json schema invalid (${result.error.issues[0]?.path.join(".")} — ${result.error.issues[0]?.message}); hooks disabled.\n`,
      );
      return null;
    }
    return result.data;
  } catch (e) {
    if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") return null;
    process.stderr.write(
      `[frondose] failed to load hooks.json (${e instanceof Error ? e.message : String(e)}); hooks disabled.\n`,
    );
    return null;
  }
}
