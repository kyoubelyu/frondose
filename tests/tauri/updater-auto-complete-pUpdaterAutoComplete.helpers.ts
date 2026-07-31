import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createAppActions } from "../../src/tauri/ui/appActions.js";

export type UpdateCompletionModule = {
  showUpdateCompletion: (deps: {
    invoke: <T = unknown>(cmd: string) => Promise<T>;
    surfaceToast: (message: string) => void;
  }) => Promise<void>;
  applyLanguageAndShowUpdateCompletion: (deps: {
    applyLanguagePref: () => Promise<void>;
    invoke: <T = unknown>(cmd: string) => Promise<T>;
    surfaceToast: (message: string) => void;
  }) => Promise<void>;
};

export async function loadUpdateCompletion(): Promise<UpdateCompletionModule> {
  const url = pathToFileURL(resolve("src/tauri/ui/updateCompletion.ts")).href;
  return (await import(url)) as UpdateCompletionModule;
}

export function createPersistedChineseActions(order: string[]) {
  const classList = {
    add() {},
    remove() {},
    contains() {
      return false;
    },
  };
  const textEl = { textContent: "", classList };
  return createAppActions({
    invoke: async <T>(cmd: string) => {
      if (cmd === "frondose_get_settings") {
        order.push("settings");
        return { ok: true, language: "zh" } as T;
      }
      throw new Error(`unexpected app action invoke: ${cmd}`);
    },
    surfaceError: () => {},
    document: { documentElement: { lang: "" }, querySelectorAll: () => [] },
    nameEl: textEl,
    errorBannerEl: textEl,
    retryBtnEl: { ...textEl, disabled: false },
    tickerEl: textEl,
    transition: () => {},
    setCurrentTurnId: () => {},
    getLastTurnPrompt: () => null,
    getWorkflowView: () => null,
  });
}

export function stripRustComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

export function extractRustFunction(source: string, name: string): string {
  const clean = stripRustComments(source);
  const start = clean.search(new RegExp(`(?:pub\\(crate\\)\\s+)?(?:async\\s+)?fn\\s+${name}\\s*`));
  assert.notEqual(start, -1, `real Rust function ${name} must exist`);
  const open = clean.indexOf("{", start);
  assert.notEqual(open, -1, `${name} must have a body`);
  let depth = 0;
  for (let i = open; i < clean.length; i += 1) {
    if (clean[i] === "{") depth += 1;
    if (clean[i] === "}") {
      depth -= 1;
      if (depth === 0) return clean.slice(start, i + 1);
    }
  }
  assert.fail(`unterminated Rust function ${name}`);
}

export function extractBraceBlock(source: string, marker: string): string {
  const clean = stripRustComments(source);
  const start = clean.indexOf(marker);
  assert.notEqual(start, -1, `real block marker must exist: ${marker}`);
  const open = clean.indexOf("{", start);
  assert.notEqual(open, -1, `${marker} must have a body`);
  let depth = 0;
  for (let i = open; i < clean.length; i += 1) {
    if (clean[i] === "{") depth += 1;
    if (clean[i] === "}") {
      depth -= 1;
      if (depth === 0) return clean.slice(start, i + 1);
    }
  }
  assert.fail(`unterminated block ${marker}`);
}

export function extractParenCall(source: string, marker: string): string {
  const clean = stripRustComments(source);
  const start = clean.indexOf(marker);
  assert.notEqual(start, -1, `real call marker must exist: ${marker}`);
  const open = clean.indexOf("(", start);
  assert.notEqual(open, -1, `${marker} must open arguments`);
  let depth = 0;
  for (let i = open; i < clean.length; i += 1) {
    if (clean[i] === "(") depth += 1;
    if (clean[i] === ")") {
      depth -= 1;
      if (depth === 0) return clean.slice(start, i + 1);
    }
  }
  assert.fail(`unterminated call ${marker}`);
}

export function braceDepthAt(source: string, index: number): number {
  const prefix = stripRustComments(source).slice(0, index);
  return [...prefix].reduce((depth, char) => {
    if (char === "{") return depth + 1;
    if (char === "}") return depth - 1;
    return depth;
  }, 0);
}

export function runCargoHarness(
  harnessRoot: string,
  name: string,
  cargoToml: string,
  mainRs: string,
  filter: string,
): string {
  const root = resolve(harnessRoot, name);
  mkdirSync(resolve(root, "src"), { recursive: true });
  writeFileSync(resolve(root, "Cargo.toml"), cargoToml);
  writeFileSync(resolve(root, "src/main.rs"), mainRs);
  return execFileSync("cargo", ["test", "--offline", filter, "--", "--nocapture"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
}

export async function waitForReadyFiles(barrier: string, count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const ready = Array.from({ length: count }, (_, index) => existsSync(resolve(barrier, `ready-${index}`)));
    if (ready.every(Boolean)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  assert.fail(`timed out waiting for ${count} process-ready files`);
}

export function runNoticeProcess(binary: string, args: string[]): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveOutput(stdout.trim());
      else reject(new Error(`notice process exited ${code}: ${stderr}`));
    });
  });
}
