import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import ts from "typescript";
import {
  type BrowserHandleLike,
  forceKillTrackedBrowser,
  openOwnedBrowser,
  runIndependentCleanups,
  trackBrowser,
  withOwnedBrowser,
} from "../_helpers/ownedBrowser.js";

const ROOT = resolve(".");
const TESTS = join(ROOT, "tests");
const REAL_OWNER_FILES = new Map([
  ["tests/tauri/button-click-pY2.1.test.ts", { open: "openOwnedChrome", finish: 1 }],
  ["tests/tauri/entry-flow-pY4.mock.test.ts", { open: "openOwnedChrome", finish: 1 }],
  ["tests/tauri/ui/assistantProgress-pUiThinkCompact.mock.test.ts", { open: "withOwnedChrome", finish: 0 }],
]);
const DI_ONLY_FILES = new Set([
  "tests/cdp/launcher-clean-profile-win7.mock.test.ts",
  "tests/cdp/launcher-pwdstore-p75d63.mock.test.ts",
  "tests/cdp/launcher.mock.test.ts",
  "tests/linkedin/session.mock.test.ts",
  "tests/linkedin/sessionLaunchDelay.mock.test.ts",
]);
const HELPER_FILE = "tests/_helpers/ownedBrowser.ts";

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(readonly pid: number) {
    super();
  }

  exit(signal: NodeJS.Signals = "SIGKILL"): void {
    this.signalCode = signal;
    this.emit("exit", null, signal);
    this.emit("close", null, signal);
  }
}

function fakeHandle(child: FakeChild, onKill: () => void): BrowserHandleLike {
  return { pid: child.pid, port: child.pid + 10_000, process: child as unknown as ChildProcess, kill: onKill };
}

function ownerOptions(
  child: FakeChild,
  onKill: () => void,
  overrides: Partial<Parameters<typeof openOwnedBrowser<object>>[0]> = {},
) {
  const client = {};
  return {
    acquire: async (onSpawn: (handle: BrowserHandleLike) => void) => onSpawn(fakeHandle(child, onKill)),
    connect: async () => client,
    close: async () => {},
    stageTimeoutMs: 20,
    exitTimeoutMs: 20,
    ...overrides,
  };
}

function allTestSources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (relative(TESTS, path).split("/")[0] !== "live") found.push(...allTestSources(path));
    } else if (/\.(?:[cm]?[jt]s)$/u.test(entry.name)) {
      found.push(relative(ROOT, path).replaceAll("\\", "/"));
    }
  }
  return found;
}

function sourceProgram(source: string) {
  const filename = "/case.ts";
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, noLib: true };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
    name === filename
      ? ts.createSourceFile(filename, source, languageVersion, true, ts.ScriptKind.TS)
      : original(name, languageVersion, onError, shouldCreateNewSourceFile);
  host.fileExists = (name) => name === filename || ts.sys.fileExists(name);
  host.readFile = (name) => (name === filename ? source : ts.sys.readFile(name));
  const program = ts.createProgram([filename], options, host);
  return { checker: program.getTypeChecker(), file: program.getSourceFile(filename)! };
}

function isChromeLauncherSpecifier(node: ts.Expression): boolean {
  return ts.isStringLiteralLike(node) && node.text === "chrome-launcher";
}

function hasRuntimeChromeLauncherImport(source: string): boolean {
  const file = ts.createSourceFile("inventory.ts", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  let found = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      isChromeLauncherSpecifier(node.moduleSpecifier) &&
      node.importClause !== undefined &&
      !node.importClause.isTypeOnly &&
      (node.importClause.name !== undefined ||
        node.importClause.namedBindings === undefined ||
        ts.isNamespaceImport(node.importClause.namedBindings) ||
        node.importClause.namedBindings.elements.some((element) => !element.isTypeOnly))
    ) {
      found = true;
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && isChromeLauncherSpecifier(node.moduleSpecifier)) {
      found = true;
    }
    if (
      ts.isCallExpression(node) &&
      ((node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        isChromeLauncherSpecifier(node.arguments[0])) ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require" &&
          node.arguments[0] &&
          isChromeLauncherSpecifier(node.arguments[0])))
    ) {
      found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function isTypeUse(node: ts.Identifier): boolean {
  for (let parent: ts.Node | undefined = node.parent; parent && !ts.isStatement(parent); parent = parent.parent) {
    if (ts.isTypeNode(parent) || ts.isImportTypeNode(parent)) return true;
  }
  return false;
}

export function analyzeChromeLauncherSource(source: string, kind: "helper" | "di" | "none"): string[] {
  const { checker, file } = sourceProgram(source);
  const errors: string[] = [];
  const bindings: Array<{ name: ts.Identifier; imported: string }> = [];

  const scanDeclarations = (node: ts.Node) => {
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && isChromeLauncherSpecifier(node.moduleSpecifier)) {
      errors.push("chrome-launcher re-export is forbidden");
    }
    if (
      ts.isCallExpression(node) &&
      ((node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] !== undefined &&
        isChromeLauncherSpecifier(node.arguments[0])) ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require" &&
          node.arguments[0] !== undefined &&
          isChromeLauncherSpecifier(node.arguments[0])))
    ) {
      errors.push("dynamic/CommonJS chrome-launcher import is unsupported");
    }
    if (ts.isImportDeclaration(node) && isChromeLauncherSpecifier(node.moduleSpecifier)) {
      if (node.importClause?.isTypeOnly) return;
      if (
        node.importClause?.name ||
        (node.importClause?.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings))
      ) {
        errors.push("default/namespace chrome-launcher imports are unsupported");
        return;
      }
      for (const specifier of node.importClause?.namedBindings?.elements ?? []) {
        if (specifier.isTypeOnly) continue;
        bindings.push({ name: specifier.name, imported: specifier.propertyName?.text ?? specifier.name.text });
      }
    }
    ts.forEachChild(node, scanDeclarations);
  };
  scanDeclarations(file);

  for (const binding of bindings) {
    if (binding.imported === "killAll") errors.push("killAll authority is forbidden");
    const symbol = checker.getSymbolAtLocation(binding.name);
    let approvedUses = 0;
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && node !== binding.name && checker.getSymbolAtLocation(node) === symbol) {
        if (isTypeUse(node)) return;
        if (
          kind === "di" &&
          ts.isCallExpression(node.parent) &&
          node.parent.expression.getText(file) === "__setLaunchFn" &&
          node.parent.arguments.length === 1 &&
          node.parent.arguments[0] === node
        ) {
          approvedUses++;
          return;
        }
        if (kind === "helper" && binding.imported === "Launcher" && ts.isNewExpression(node.parent)) {
          approvedUses++;
          return;
        }
        errors.push(`unsupported ${binding.imported} value use: ${node.parent.getText(file)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (kind === "helper" && (binding.imported !== "Launcher" || approvedUses !== 1)) {
      errors.push("helper must construct exactly one Launcher");
    }
    if (kind === "di" && (binding.imported !== "launch" || approvedUses < 1)) {
      errors.push("DI import must be launch and used only for exact restoration");
    }
    if (kind === "none") errors.push("unclassified runtime chrome-launcher import");
  }
  return errors;
}

function countImportedCalls(source: string, importedName: string, moduleSuffix: string): number {
  const { checker, file } = sourceProgram(source);
  let binding: ts.Identifier | undefined;
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.moduleSpecifier.getText(file).includes(moduleSuffix)) continue;
    for (const specifier of statement.importClause?.namedBindings &&
    ts.isNamedImports(statement.importClause.namedBindings)
      ? statement.importClause.namedBindings.elements
      : []) {
      if ((specifier.propertyName?.text ?? specifier.name.text) === importedName) binding = specifier.name;
    }
  }
  if (!binding) return 0;
  const symbol = checker.getSymbolAtLocation(binding);
  let calls = 0;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      checker.getSymbolAtLocation(node.expression) === symbol
    ) {
      calls++;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return calls;
}

function analyzeSuiteOwner(source: string, ownerName: string, openName: string): string[] {
  const { checker, file } = sourceProgram(source);
  const errors: string[] = [];
  let ownerSymbol: ts.Symbol | undefined;
  let openSymbol: ts.Symbol | undefined;
  let assignments = 0;
  let finishes = 0;

  const findBindings = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === ownerName) {
      ownerSymbol = checker.getSymbolAtLocation(node.name);
    }
    if (ts.isImportSpecifier(node) && (node.propertyName?.text ?? node.name.text) === openName) {
      openSymbol = checker.getSymbolAtLocation(node.name);
    }
    ts.forEachChild(node, findBindings);
  };
  findBindings(file);

  const visit = (node: ts.Node) => {
    const assignmentValue =
      ts.isBinaryExpression(node) && ts.isAwaitExpression(node.right)
        ? node.right.expression
        : ts.isBinaryExpression(node)
          ? node.right
          : undefined;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      checker.getSymbolAtLocation(node.left) === ownerSymbol &&
      assignmentValue !== undefined &&
      ts.isCallExpression(assignmentValue) &&
      ts.isIdentifier(assignmentValue.expression) &&
      checker.getSymbolAtLocation(assignmentValue.expression) === openSymbol
    ) {
      assignments++;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "finish" &&
      ts.isIdentifier(node.expression.expression) &&
      checker.getSymbolAtLocation(node.expression.expression) === ownerSymbol
    ) {
      finishes++;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "kill" &&
      !(ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "httpUi")
    ) {
      errors.push(`raw process/browser kill authority: ${node.getText(file)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!ownerSymbol || !openSymbol || assignments !== 1 || finishes !== 1) {
    errors.push(`suite owner must have one ${ownerName}=${openName}(...) assignment and one same-owner finish`);
  }
  return errors;
}

function analyzeInlineOwner(source: string, openName: string): string[] {
  const errors: string[] = [];
  if (countImportedCalls(source, openName, "ownedBrowser") !== 1) {
    errors.push(`inline owner must call ${openName} exactly once`);
  }
  const file = ts.createSourceFile("inline-owner.ts", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "kill"
    ) {
      errors.push(`raw process/browser kill authority: ${node.getText(file)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return errors;
}

describe("exact browser owner state machine", () => {
  it("T-BrowserCleanup.1: delayed A exit settles only A and removes every listener", async () => {
    // Given two fake children, when B exits first and A exits after A's bound kill, then only A authority is used and all owner listeners are removed.
    const a = new FakeChild(101);
    const b = new FakeChild(202);
    let aKills = 0;
    let bKills = 0;
    const tracked = trackBrowser(
      fakeHandle(a, () => {
        aKills++;
        setTimeout(() => a.exit(), 5);
      }),
    );
    const bHandle = fakeHandle(b, () => bKills++);
    b.exit();
    await forceKillTrackedBrowser(tracked, 50);
    assert.equal(aKills, 1);
    assert.equal(bKills, 0);
    assert.equal(bHandle.pid, 202);
    assert.equal(a.listenerCount("exit") + a.listenerCount("close"), 0);
  });

  it("T-BrowserCleanup.2: already-exited child receives no kill and invalid identities are rejected", async () => {
    // Given exited and invalid fake children, when tracked/cleaned, then exit is accepted without a signal and unsafe identities never gain authority.
    const exited = new FakeChild(303);
    exited.exitCode = 0;
    let kills = 0;
    await forceKillTrackedBrowser(trackBrowser(fakeHandle(exited, () => kills++)), 20);
    assert.equal(kills, 0);
    assert.throws(() => trackBrowser(fakeHandle(new FakeChild(0), () => {})), /invalid browser identity/);
    const mismatch = fakeHandle(new FakeChild(404), () => {});
    mismatch.pid = 405;
    assert.throws(() => trackBrowser(mismatch), /invalid browser identity/);
  });

  it("T-BrowserCleanup.3: mutable handle fields cannot redirect frozen A authority to B", async () => {
    // Given A tracked before its handle is mutated to B, when cleanup runs, then captured A kill runs once, B never runs, and mutation remains observable.
    const a = new FakeChild(501);
    const b = new FakeChild(502);
    let aKills = 0;
    let bKills = 0;
    const handle = fakeHandle(a, () => {
      aKills++;
      a.exit();
    });
    const tracked = trackBrowser(handle);
    handle.pid = b.pid;
    handle.process = b as unknown as ChildProcess;
    handle.kill = () => bKills++;
    await assert.rejects(forceKillTrackedBrowser(tracked, 20), /browser identity changed|exact browser cleanup failed/);
    assert.equal(aKills, 1);
    assert.equal(bKills, 0);
  });

  it("T-BrowserCleanup.4: no-exit timeout and kill throw dispose listeners and fail", async () => {
    // Given an exact child that never exits and whose bound kill throws, when cleanup times out, then both failures surface and no listeners remain.
    const child = new FakeChild(601);
    const tracked = trackBrowser(
      fakeHandle(child, () => {
        throw new Error("kill failed");
      }),
    );
    await assert.rejects(forceKillTrackedBrowser(tracked, 10), AggregateError);
    assert.equal(child.listenerCount("exit") + child.listenerCount("close"), 0);
  });

  it("T-BrowserCleanup.5: reject-after-spawn, connect rejection, and never-settling setup all clean exact Chrome", async () => {
    // Given failures at each pre-body stage, when ownership unwinds, then each exact child is force-killed before the original failure returns.
    for (const stage of ["acquire", "connect", "setup-timeout"] as const) {
      const child = new FakeChild(700 + stage.length);
      let kills = 0;
      const primary = new Error(stage);
      const options = ownerOptions(child, () => {
        kills++;
        child.exit();
      });
      if (stage === "acquire")
        options.acquire = async (onSpawn) => {
          onSpawn(
            fakeHandle(
              child,
              options.acquire
                ? () => {
                    kills++;
                    child.exit();
                  }
                : () => {},
            ),
          );
          throw primary;
        };
      if (stage === "connect")
        options.connect = async () => {
          throw primary;
        };
      if (stage === "setup-timeout") options.setup = () => new Promise<void>(() => {});
      await assert.rejects(openOwnedBrowser(options));
      assert.equal(kills, 1, `${stage} must kill its exact spawned child once`);
    }
  });

  it("T-BrowserCleanup.6: body, close, and cleanup failures preserve deterministic order", async () => {
    // Given body, close, and cleanup failures, when the owner unwinds, then one AggregateError retains primary, close, cleanup order.
    const child = new FakeChild(801);
    const bodyError = new Error("body failed");
    const closeError = new Error("close failed");
    let caught: unknown;
    try {
      await withOwnedBrowser(
        ownerOptions(
          child,
          () => {
            throw new Error("kill failed");
          },
          {
            close: async () => {
              throw closeError;
            },
            exitTimeoutMs: 5,
          },
        ),
        async () => {
          throw bodyError;
        },
      );
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof AggregateError);
    assert.strictEqual(caught.errors[0], bodyError);
    assert.strictEqual(caught.errors[1], closeError);
    assert.match(String(caught.errors[2]), /exact browser cleanup failed/);
    assert.equal(child.listenerCount("exit") + child.listenerCount("close"), 0);
  });

  it("T-BrowserCleanup.7: close timeout cannot prevent exact cleanup", async () => {
    // Given a never-settling close, when finish runs, then its deadline fires and exact browser cleanup still completes.
    const child = new FakeChild(901);
    let kills = 0;
    const owner = await openOwnedBrowser(
      ownerOptions(
        child,
        () => {
          kills++;
          child.exit();
        },
        { close: () => new Promise<void>(() => {}), stageTimeoutMs: 5 },
      ),
    );
    await assert.rejects(owner.finish(), /close.*timed out/);
    assert.equal(kills, 1);
  });

  it("T-BrowserCleanup.8: independent cleanup attempts HTTP teardown after browser failure", async () => {
    // Given browser cleanup fails, when independent suite cleanup runs, then the exact HTTP cleanup step still executes and the browser error remains first.
    const browserError = new Error("browser finish failed");
    let httpKills = 0;
    let caught: unknown;
    try {
      await runIndependentCleanups("suite", [
        async () => {
          throw browserError;
        },
        () => {
          httpKills++;
        },
      ]);
    } catch (error) {
      caught = error;
    }
    assert.strictEqual(caught, browserError);
    assert.equal(httpKills, 1);
  });
});

describe("non-live chrome-launcher ownership inventory", () => {
  it("T-BrowserCleanup.9: repository imports and owner callsites match the exact closed inventory", () => {
    // Given every non-live test source, when AST value-flow is classified, then only one helper and five DI restore imports exist and all three owners have one callsite.
    const chromeFiles: string[] = [];
    for (const path of allTestSources(TESTS)) {
      const source = readFileSync(join(ROOT, path), "utf8");
      if (!hasRuntimeChromeLauncherImport(source)) continue;
      chromeFiles.push(path);
      const kind = path === HELPER_FILE ? "helper" : DI_ONLY_FILES.has(path) ? "di" : "none";
      assert.deepEqual(analyzeChromeLauncherSource(source, kind), [], path);
    }
    assert.deepEqual(new Set(chromeFiles), new Set([HELPER_FILE, ...DI_ONLY_FILES]));
    for (const [path, expected] of REAL_OWNER_FILES) {
      const source = readFileSync(join(ROOT, path), "utf8");
      assert.equal(countImportedCalls(source, expected.open, "ownedBrowser"), 1, path);
      assert.equal((source.match(/browserOwner\?\.finish\(/gu) ?? []).length, expected.finish, path);
      assert.deepEqual(
        expected.finish === 1
          ? analyzeSuiteOwner(source, "browserOwner", expected.open)
          : analyzeInlineOwner(source, expected.open),
        [],
        path,
      );
      assert.doesNotMatch(source, /\bkillAll\b|\b(?:pkill|killall|taskkill)\b/u);
    }
    assert.ok(
      readFileSync(join(ROOT, "tests/tauri/ui/assistantProgress-pUiThinkCompact.mock.test.ts"), "utf8").split("\n")
        .length <= 800,
    );
  });

  it("T-BrowserCleanup.10: hostile import and value-flow syntax fails closed while legitimate controls pass", () => {
    // Given hostile and benign in-memory syntax forms, when the same analyzer runs, then unsupported authority is rejected without flagging shadowed/type/HTTP controls.
    const rejected = [
      `const {launch} = await import("chrome-launcher"); launch();`,
      `import * as chrome from "chrome-launcher"; chrome.launch();`,
      `import {launch as x} from "chrome-launcher"; __setLaunchFn(x); x.call(null);`,
      `import {launch as x} from "chrome-launcher"; __setLaunchFn(x); Reflect.apply(x, null, []);`,
      `import {killAll as reap} from "chrome-launcher"; __setLaunchFn(reap);`,
      `export {launch as start} from "chrome-launcher";`,
      `const chrome = require("chrome-launcher"); chrome.launch();`,
    ];
    for (const source of rejected) assert.notDeepEqual(analyzeChromeLauncherSource(source, "di"), [], source);
    assert.deepEqual(
      analyzeChromeLauncherSource(
        `import type {LaunchedChrome} from "chrome-launcher"; const httpUi={kill(){}}; httpUi.kill();`,
        "none",
      ),
      [],
    );
    assert.deepEqual(
      analyzeChromeLauncherSource(
        `import {launch as x} from "chrome-launcher"; __setLaunchFn(x); function f(x:()=>void){x();}`,
        "di",
      ),
      [],
    );
    assert.notDeepEqual(
      analyzeSuiteOwner(
        `import {openOwnedChrome as open} from "./ownedBrowser.js"; let browserOwner: any; browserOwner = open({}); browserOwner.browser.handle.kill();`,
        "browserOwner",
        "openOwnedChrome",
      ),
      [],
    );
    assert.deepEqual(
      analyzeSuiteOwner(
        `import {openOwnedChrome as open} from "./ownedBrowser.js"; let browserOwner: any; let httpUi: any; browserOwner = open({}); browserOwner.finish(); httpUi.kill("SIGKILL");`,
        "browserOwner",
        "openOwnedChrome",
      ),
      [],
    );
  });
});
