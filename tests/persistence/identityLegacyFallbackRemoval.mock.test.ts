import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { describe, it } from "node:test";
import ts from "typescript";
import * as configModule from "../../src/persistence/config.js";
import { configJsonSchemaV2, readConfig } from "../../src/persistence/config.js";
import { readIdentity, writeIdentity } from "../../src/persistence/identity.js";
import type { IdentityRecord } from "../../src/persistence/identitySchema.js";
import { makeAllTools, type PersistencePaths } from "../../src/tools/index.js";
import { cleanupTmpDir, makeTmpDir } from "../_helpers/tmp";

const A: IdentityRecord = {
  fullName: "Current Alice",
  company: "Current Co",
  icp: { targetRole: ["VP Sales"], region: ["Europe"] },
  updatedAt: "2026-08-12T00:00:00.000Z",
};
const B: IdentityRecord = {
  fullName: "Legacy Bob",
  company: "Hostile Co",
  icp: { targetRole: ["Legacy Engineer"], region: ["Mars"] },
  updatedAt: "2026-08-12T00:00:01.000Z",
};
const C: IdentityRecord = { ...A, fullName: "Current Carol", updatedAt: "2026-08-12T00:00:02.000Z" };

function writeHostileIdentity(agent: string, record: IdentityRecord): string {
  const bytes = JSON.stringify(record);
  writeFileSync(join(agent, "identity.json"), bytes, "utf8");
  return bytes;
}

const currentConfig = (identity: IdentityRecord | undefined = A) => ({
  schema_version: 2 as const,
  server: {
    url: "https://server.example.test",
    bind_address: "100.64.0.9",
    poll_interval_s: 45,
    web_port: 9001,
    ssh_user: "operator",
    ssh_port: 2202,
    rest_port: 4041,
  },
  worker: { id: "worker-a", hostname: "host-a", label: "label-a", input_mode: "hardware" as const },
  telegram: { enabled: true, boundUserId: 42, proxyUrl: "http://127.0.0.1:7890" },
  identity,
  soul: { override: "current soul" },
  updateServerUrl: null,
  language: "zh" as const,
  auto: { intervalMinutes: 60 },
});

function withHome(run: (p: { root: string; agent: string; config: string; identity: string }) => void | Promise<void>) {
  const root = makeTmpDir("frondose-no-config-legacy");
  const previous = process.env.FRONDOSE_HOME_BASE;
  process.env.FRONDOSE_HOME_BASE = root;
  const agent = join(root, ".frondose", "agent");
  const config = join(agent, "config.json");
  const identity = join(agent, "identity.json");
  mkdirSync(agent, { recursive: true });
  return Promise.resolve(run({ root, agent, config, identity })).finally(() => {
    if (previous === undefined) delete process.env.FRONDOSE_HOME_BASE;
    else process.env.FRONDOSE_HOME_BASE = previous;
    cleanupTmpDir(root);
  });
}

function maintainedTsFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && !["target", "dist", "node_modules"].includes(entry.name)) walk(path);
      else if (entry.isFile() && path.endsWith(".ts")) files.push(path);
    }
  };
  walk(root);
  return files;
}

function maintainedFiles(root: string, extensions: ReadonlySet<string>): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && !["target", "dist", "node_modules"].includes(entry.name)) walk(path);
      else if (entry.isFile() && extensions.has(extname(path))) files.push(path);
    }
  };
  walk(root);
  return files;
}

function constInitializers(sourceFile: ts.SourceFile): Map<string, ts.Expression> {
  const values = new Map<string, ts.Expression>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      values.set(node.name.text, node.initializer);
    }
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const returned = node.body.statements.find(ts.isReturnStatement)?.expression;
      if (returned) values.set(node.name.text, returned);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return values;
}

function staticText(
  node: ts.Node | undefined,
  values: ReadonlyMap<string, ts.Expression>,
  seen = new Set<string>(),
): string {
  if (!node) return "";
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
    return staticText(node.expression, values, seen);
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const returned = ts.isBlock(node.body) ? node.body.statements.find(ts.isReturnStatement)?.expression : node.body;
    return staticText(returned, values, seen);
  }
  if (ts.isIdentifier(node)) {
    if (seen.has(node.text)) return "";
    const initializer = values.get(node.text);
    if (!initializer) return "";
    const nextSeen = new Set(seen).add(node.text);
    return staticText(initializer, values, nextSeen);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return `${staticText(node.left, values, seen)}${staticText(node.right, values, seen)}`;
  }
  if (ts.isTemplateExpression(node)) {
    return `${node.head.text}${node.templateSpans
      .map((span) => `${staticText(span.expression, values, seen)}${span.literal.text}`)
      .join("")}`;
  }
  if (ts.isCallExpression(node)) {
    const helperName = ts.isIdentifier(node.expression) ? node.expression.text : undefined;
    const returned = helperName && !seen.has(helperName) ? values.get(helperName) : undefined;
    const helperText = returned ? staticText(returned, values, new Set(seen).add(helperName!)) : "";
    return `${helperText}${node.arguments.map((argument) => staticText(argument, values, seen)).join("")}`;
  }
  return "";
}

function executableLegacyPathHits(source: string, fileName = "fixture.ts"): string[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const values = constInitializers(sourceFile);
  const hits = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) ||
      ts.isTemplateExpression(node) ||
      ts.isCallExpression(node) ||
      ts.isVariableDeclaration(node)
    ) {
      const text = staticText(node, values).toLowerCase();
      for (const retired of ["identity.json", "soul_band_override.txt"]) {
        if (text.includes(retired)) hits.add(retired);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...hits].sort();
}

function legacyFileWriteHits(source: string, fileName = "fixture.ts"): string[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const values = constInitializers(sourceFile);
  const writerNames = new Set(["writeFile", "writeFileSync", "appendFile", "appendFileSync"]);
  const directWriters = new Set(writerNames);
  const namespaces = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!["fs", "node:fs", "fs/promises", "node:fs/promises"].includes(statement.moduleSpecifier.text)) continue;
    const defaultImport = statement.importClause?.name;
    if (defaultImport) namespaces.add(defaultImport.text);
    const bindings = statement.importClause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (writerNames.has(imported)) directWriters.add(element.name.text);
      }
    }
  }
  const isWriter = (node: ts.Expression, seen = new Set<string>()): boolean => {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      return isWriter(node.expression, seen);
    }
    if (ts.isIdentifier(node)) {
      if (directWriters.has(node.text)) return true;
      if (seen.has(node.text)) return false;
      const initializer = values.get(node.text);
      return initializer ? isWriter(initializer, new Set(seen).add(node.text)) : false;
    }
    if (!ts.isPropertyAccessExpression(node) || !writerNames.has(node.name.text)) return false;
    let owner: ts.Expression = node.expression;
    while (ts.isPropertyAccessExpression(owner)) owner = owner.expression;
    return ts.isIdentifier(owner) && namespaces.has(owner.text);
  };
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (isWriter(node.expression)) {
        const pathText = staticText(node.arguments[0], values).toLowerCase();
        if (pathText.includes("identity.json")) hits.push("identity.json write");
        if (pathText.includes("soul_band_override.txt")) hits.push("soul_band_override.txt write");
        if (pathText.includes("config.json") && node.arguments[1] && hasEmptyTargetRole(node.arguments[1], values)) {
          hits.push("schema-invalid empty targetRole config write");
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return hits;
}

function hasEmptyTargetRole(
  node: ts.Node,
  values: ReadonlyMap<string, ts.Expression>,
  seen = new Set<string>(),
): boolean {
  if (ts.isIdentifier(node)) {
    if (seen.has(node.text)) return false;
    const initializer = values.get(node.text);
    return initializer ? hasEmptyTargetRole(initializer, values, new Set(seen).add(node.text)) : false;
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    const helperName = node.expression.text;
    if (!seen.has(helperName)) {
      const returned = values.get(helperName);
      if (returned && hasEmptyTargetRole(returned, values, new Set(seen).add(helperName))) return true;
    }
  }
  if (
    ts.isPropertyAssignment(node) &&
    ((ts.isIdentifier(node.name) && node.name.text === "targetRole") ||
      (ts.isStringLiteralLike(node.name) && node.name.text === "targetRole")) &&
    ts.isArrayLiteralExpression(node.initializer) &&
    node.initializer.elements.length === 0
  ) {
    return true;
  }
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && hasEmptyTargetRole(child, values, seen)) found = true;
  });
  return found;
}

type CurrentHostSkip = {
  path: string;
  title: string;
  mechanism: "skip-unless-win32";
};

function unwrapExpression(
  node: ts.Expression,
  values: ReadonlyMap<string, ts.Expression>,
  seen = new Set<string>(),
): ts.Expression {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return unwrapExpression(node.expression, values, seen);
  }
  if (ts.isIdentifier(node) && !seen.has(node.text)) {
    const initializer = values.get(node.text);
    if (initializer) return unwrapExpression(initializer, values, new Set(seen).add(node.text));
  }
  return node;
}

function isProcessPlatform(node: ts.Expression, values: ReadonlyMap<string, ts.Expression>): boolean {
  const value = unwrapExpression(node, values);
  return (
    ts.isPropertyAccessExpression(value) &&
    value.name.text === "platform" &&
    ts.isIdentifier(value.expression) &&
    value.expression.text === "process"
  );
}

function platformSkipKind(
  node: ts.Expression,
  values: ReadonlyMap<string, ts.Expression>,
): "skip-unless-win32" | "skip-on-win32" | undefined {
  const value = unwrapExpression(node, values);
  if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.ExclamationToken) {
    const nested = platformSkipKind(value.operand, values);
    if (nested === "skip-unless-win32") return "skip-on-win32";
    if (nested === "skip-on-win32") return "skip-unless-win32";
  }
  if (!ts.isBinaryExpression(value)) return undefined;
  const leftIsPlatform = isProcessPlatform(value.left, values);
  const rightIsPlatform = isProcessPlatform(value.right, values);
  const other = leftIsPlatform
    ? unwrapExpression(value.right, values)
    : rightIsPlatform
      ? unwrapExpression(value.left, values)
      : undefined;
  if (!other || !ts.isStringLiteralLike(other) || other.text !== "win32") return undefined;
  if (
    value.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    value.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken
  ) {
    return "skip-unless-win32";
  }
  if (
    value.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    value.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken
  ) {
    return "skip-on-win32";
  }
  return undefined;
}

function expressionMentionsPlatform(
  node: ts.Node,
  values: ReadonlyMap<string, ts.Expression>,
  seen = new Set<string>(),
): boolean {
  if (ts.isIdentifier(node) && !seen.has(node.text)) {
    const initializer = values.get(node.text);
    if (initializer && expressionMentionsPlatform(initializer, values, new Set(seen).add(node.text))) return true;
  }
  if (ts.isExpression(node) && isProcessPlatform(node, values)) return true;
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && expressionMentionsPlatform(child, values, seen)) found = true;
  });
  return found;
}

function propertyText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return undefined;
}

function currentHostSkipInventory(sources: ReadonlyArray<{ path: string; source: string }>): CurrentHostSkip[] {
  const entries: CurrentHostSkip[] = [];
  for (const { path, source } of sources) {
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const values = constInitializers(sourceFile);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.arguments.length >= 2) {
        const title = staticText(node.arguments[0], values);
        const options = unwrapExpression(node.arguments[1], values);
        if (title && ts.isObjectLiteralExpression(options)) {
          for (const property of options.properties) {
            if (!ts.isPropertyAssignment(property) || propertyText(property.name) !== "skip") continue;
            const kind = platformSkipKind(property.initializer, values);
            if (!kind && expressionMentionsPlatform(property.initializer, values)) {
              throw new Error(`${path}: unresolved process.platform-derived skip predicate for ${title}`);
            }
            if (kind === "skip-unless-win32") entries.push({ path, title, mechanism: kind });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return entries.sort((a, b) => `${a.path}\0${a.title}`.localeCompare(`${b.path}\0${b.title}`));
}

const expectedCurrentHostSkips: CurrentHostSkip[] = [
  {
    path: "tests/build/build-runtime-windows-win7.mock.test.ts",
    title: "T-WIN7.Runtime.2: when bundled node reports ABI 137, buildRuntimeWindows fails before npm ci",
    mechanism: "skip-unless-win32",
  },
  {
    path: "tests/build/build-runtime-windows-win7.mock.test.ts",
    title: "T-WIN7.Runtime.4: after install, buildRuntimeWindows verifies better-sqlite3 with build/runtime/node.exe",
    mechanism: "skip-unless-win32",
  },
];

function assertExactCurrentHostSkips(sources: ReadonlyArray<{ path: string; source: string }>): void {
  assert.deepEqual(currentHostSkipInventory(sources), expectedCurrentHostSkips);
}

describe("schema-v2 config is the only identity and config authority", () => {
  it("T-NO-ID-LEGACY.1: missing current config ignores every hostile sibling and performs no migration write", async () => {
    // Given hostile identity, Soul, and Telegram siblings with no config; When current state is read; Then defaults are returned without touching bytes.
    await withHome(({ agent, config, identity }) => {
      const hostileIdentity = writeHostileIdentity(agent, B);
      const hostile = new Map([
        [join(agent, "soul_band_override.txt"), "hostile soul"],
        [join(agent, "telegram.json"), JSON.stringify({ enabled: true, boundUserId: 99 })],
      ]);
      for (const [path, bytes] of hostile) writeFileSync(path, bytes, "utf8");
      assert.equal(readIdentity(config), null);
      assert.equal(readConfig(config).telegram.enabled, false);
      assert.equal(existsSync(config), false);
      assert.equal(readFileSync(identity, "utf8"), hostileIdentity);
      for (const [path, bytes] of hostile) assert.equal(readFileSync(path, "utf8"), bytes);
    });
  });

  it("T-NO-ID-LEGACY.2: current identity A wins over contradictory hostile identity B", async () => {
    // Given current A and hostile B; When identity is read; Then A wins and B stays byte-identical.
    await withHome(({ agent, config, identity }) => {
      writeFileSync(config, JSON.stringify(currentConfig(A)), "utf8");
      const hostile = writeHostileIdentity(agent, B);
      assert.deepEqual(readIdentity(config), A);
      assert.equal(readFileSync(identity, "utf8"), hostile);
    });
  });

  it("T-NO-ID-LEGACY.3: writing C preserves the complete non-identity projection and hostile bytes", async () => {
    // Given every current sibling has a distinct value; When C is written; Then the whole nonidentity projection is unchanged.
    await withHome(({ agent, config, identity }) => {
      const before = currentConfig(A);
      writeFileSync(config, JSON.stringify(before), "utf8");
      const hostile = writeHostileIdentity(agent, B);
      const { identity: _beforeIdentity, ...beforeSiblings } = readConfig(config);
      writeIdentity(C, config);
      const { identity: afterIdentity, ...afterSiblings } = readConfig(config);
      assert.deepEqual(afterIdentity, C);
      assert.deepEqual(afterSiblings, beforeSiblings);
      assert.equal(readFileSync(identity, "utf8"), hostile);
    });
  });

  it("T-NO-ID-LEGACY.4: identity write creates no retired sibling", async () => {
    // Given current A and no identity sidecar; When C is written; Then only current config changes.
    await withHome(({ config, identity }) => {
      writeFileSync(config, JSON.stringify(currentConfig(A)), "utf8");
      writeIdentity(C, config);
      assert.deepEqual(readConfig(config).identity, C);
      assert.equal(existsSync(identity), false);
    });
  });

  it("T-NO-ID-LEGACY.5: obsolete schema v1 is rejected without rewrite or sibling folding", async () => {
    // Given v1 bytes and all legacy siblings; When config is read; Then current defaults return and every disk byte remains unchanged.
    await withHome(({ agent, config, identity }) => {
      const v1 = JSON.stringify({ schema_version: 1, telegram: { enabled: true } });
      const siblings = new Map([
        [join(agent, "soul_band_override.txt"), "legacy soul"],
        [join(agent, "telegram.json"), JSON.stringify({ enabled: true })],
      ]);
      writeFileSync(config, v1, "utf8");
      const hostileIdentity = writeHostileIdentity(agent, B);
      for (const [path, bytes] of siblings) writeFileSync(path, bytes, "utf8");
      const result = readConfig(config);
      assert.equal(result.schema_version, 2);
      assert.equal(result.identity, undefined);
      assert.equal(result.telegram.enabled, false);
      assert.equal(result.soul.override, null);
      assert.equal(readFileSync(config, "utf8"), v1);
      assert.equal(readFileSync(identity, "utf8"), hostileIdentity);
      for (const [path, bytes] of siblings) assert.equal(readFileSync(path, "utf8"), bytes);
    });
  });
});

describe("real factory consumers receive current config wiring", () => {
  it("T-NO-ID-LEGACY.6: makeAllTools getIdentity, qualify_profile, and identity ignore hostile sidecar B", async () => {
    // Given real factory tools with current config A and hostile B; When read, qualify, and patch run; Then only A/current config participates.
    await withHome(async ({ root, agent, config, identity }) => {
      const injectedConfig = join(root, "injected", "config.json");
      mkdirSync(join(root, "injected"), { recursive: true });
      writeFileSync(config, JSON.stringify(currentConfig(B)), "utf8");
      writeFileSync(injectedConfig, JSON.stringify(currentConfig(A)), "utf8");
      const hostile = writeHostileIdentity(agent, B);
      const persistence = {
        memoryDbPath: join(root, "memory.sqlite"),
        salesDbPath: join(root, "sales.sqlite"),
        configPath: injectedConfig,
      } as unknown as PersistencePaths;
      const tools = makeAllTools(undefined, persistence) as unknown as Record<
        string,
        {
          execute: (
            input: Record<string, unknown>,
            options: { toolCallId: string; messages: never[] },
          ) => Promise<unknown>;
        }
      >;
      const opts = { toolCallId: "current-config", messages: [] };
      const got = (await tools.getIdentity.execute({}, opts)) as {
        data: { record: { fullName: string } };
      };
      assert.equal(got.data.record.fullName, A.fullName);
      const qualified = (await tools.qualify_profile.execute(
        { role: "VP Sales", region: "Europe", companyName: "Other Co" },
        opts,
      )) as { data: { qualification: string } };
      assert.equal(qualified.data.qualification, "qualified");
      const updated = (await tools.identity.execute({ fullName: "Factory Carol" }, opts)) as { ok: boolean };
      assert.equal(updated.ok, true);
      assert.equal(readConfig(injectedConfig).identity?.fullName, "Factory Carol");
      assert.deepEqual(readConfig(config).identity, B);
      assert.equal(readFileSync(identity, "utf8"), hostile);
    });
  });
});

describe("obsolete source, fixture, and skip ownership is closed", () => {
  it("T-NO-ID-LEGACY.7: production contains no identity fallback or config migration symbols", () => {
    // Given all maintained production TypeScript and hostile AST controls; When obsolete authority is inspected; Then no executable path or symbol remains.
    assert.deepEqual(
      executableLegacyPathHits(`import { readFileSync as get } from "node:fs";
        const stem = "identity";
        const retired = join(dir, stem + ".json");
        get(retired);`),
      ["identity.json"],
    );
    assert.deepEqual(
      executableLegacyPathHits(`const name = "soul_band_" + "override.txt"; readFileSync(join(dir, name));`),
      ["soul_band_override.txt"],
    );
    assert.deepEqual(
      executableLegacyPathHits(`// identity.json is only comment data\nconst current = "config.json";`),
      [],
    );
    const forbidden = [
      "DEFAULT_IDENTITY_PATH",
      "legacyReadIdentityFromFile",
      "legacyWriteIdentityToFile",
      "identityPath",
      "configJsonSchemaV1",
      "ConfigJsonV1",
      "migrateV1toV2",
      "migrateTelegramIntoConfig",
      "export const configJsonSchema =",
      "export type ConfigJson =",
      "soul_band_override.txt",
      'join(dir, "identity.json")',
    ];
    const hits: string[] = [];
    for (const file of maintainedTsFiles(join(process.cwd(), "src"))) {
      const source = readFileSync(file, "utf8");
      for (const token of forbidden)
        if (source.includes(token)) hits.push(`${relative(process.cwd(), file)}: ${token}`);
      for (const retiredPath of executableLegacyPathHits(source, file)) {
        hits.push(`${relative(process.cwd(), file)}: executable ${retiredPath}`);
      }
    }
    assert.deepEqual(hits, []);
    assert.equal("configJsonSchema" in configModule, false);
    const configSource = readFileSync(join(process.cwd(), "src/persistence/config.ts"), "utf8");
    const sourceFile = ts.createSourceFile("config.ts", configSource, ts.ScriptTarget.Latest, true);
    const exported = new Set<string>();
    for (const statement of sourceFile.statements) {
      const hasExport = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
      if (hasExport && "name" in statement && statement.name && ts.isIdentifier(statement.name)) {
        exported.add(statement.name.text);
      }
      if (hasExport && ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) exported.add(declaration.name.text);
        }
      }
      if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) exported.add(element.name.text);
      }
    }
    assert.equal(exported.has("configJsonSchema"), false);
    assert.equal(exported.has("ConfigJson"), false);
  });

  it("T-NO-ID-LEGACY.8: repository-derived test inventory contains no identityPath or flat-file write fixture", () => {
    // Given every maintained test/JSON fixture plus hostile alias/identifier/spread controls; When writes are inspected structurally; Then only named hostile canaries remain.
    const phaseCarrier = join(process.cwd(), "tests/persistence/identityLegacyFallbackRemoval.mock.test.ts");
    assert.deepEqual(
      legacyFileWriteHits(`import { writeFileSync as put } from "node:fs";
        const suffix = ".json";
        const path = join(dir, "identity" + suffix);
        const payload = { ...base, fullName: "Flat", updatedAt: "now" };
        put(path, JSON.stringify(payload));`),
      ["identity.json write"],
    );
    assert.deepEqual(
      legacyFileWriteHits(`import { writeFileSync } from "node:fs";
        const path = join(dir, "config.json");
        const payload = { schema_version: 2, identity: { icp: { targetRole: [] } } };
        writeFileSync(path, JSON.stringify(payload));`),
      ["schema-invalid empty targetRole config write"],
    );
    assert.deepEqual(
      legacyFileWriteHits(`import * as io from "node:fs";
        function legacyPath() { return join(dir, "identity", ".json"); }
        io.writeFileSync(legacyPath(), JSON.stringify({ fullName: "Flat", updatedAt: "now" }));`),
      ["identity.json write"],
    );
    assert.deepEqual(
      legacyFileWriteHits(`import { writeFile as put } from "node:fs/promises";
        const legacyPath = () => join(dir, "identity", ".json");
        put(legacyPath(), JSON.stringify({ fullName: "Flat", updatedAt: "now" }));`),
      ["identity.json write"],
    );
    assert.deepEqual(
      legacyFileWriteHits(`import fs from "node:fs";
        const put = fs.writeFileSync;
        put(join(dir, "identity.json"), JSON.stringify({ fullName: "Flat", updatedAt: "now" }));`),
      ["identity.json write"],
    );
    assert.deepEqual(
      legacyFileWriteHits(`import * as fs from "node:fs";
        fs.promises.writeFile(join(dir, "identity.json"), JSON.stringify({ fullName: "Flat", updatedAt: "now" }));`),
      ["identity.json write"],
    );
    assert.deepEqual(
      legacyFileWriteHits(`import { writeFileSync } from "node:fs";
        function invalidConfig() { return { schema_version: 2, identity: { icp: { targetRole: [] } } }; }
        writeFileSync(join(dir, "config.json"), JSON.stringify(invalidConfig()));`),
      ["schema-invalid empty targetRole config write"],
    );
    const salesCarrier = readFileSync(
      join(process.cwd(), "tests/tools/sales/promoteCandidateToLead-pAuto15b.mock.test.ts"),
      "utf8",
    );
    assert.match(salesCarrier, /schema_version: 2/);
    assert.match(salesCarrier, /Hostile Legacy Role/);
    const scenarioSource = readFileSync(join(process.cwd(), "tests/scenarios/setup.ts"), "utf8");
    assert.match(scenarioSource, /TEST_CONFIG_PATH/);
    assert.doesNotMatch(scenarioSource, /TEST_IDENTITY_PATH|test-identity\.json/);
    assert.equal(existsSync(join(process.cwd(), "tests/fixtures/test-identity.json")), false);
    assert.equal(
      configJsonSchemaV2.safeParse(
        JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/test-config.json"), "utf8")),
      ).success,
      true,
    );
    const expectedHostileWriterCounts = new Map([
      [relative(process.cwd(), phaseCarrier), 1],
      ["tests/persistence/identityConfigWriteFailure.mock.test.ts", 0],
      ["tests/tools/sales/promoteCandidateToLead-pAuto15b.mock.test.ts", 1],
    ]);
    const seenHostileWriters = new Set<string>();
    const hits: string[] = [];
    for (const file of maintainedTsFiles(join(process.cwd(), "tests"))) {
      const source = readFileSync(file, "utf8");
      const fileName = relative(process.cwd(), file);
      if (file !== phaseCarrier && /\bidentityPath\b/.test(source)) hits.push(`${fileName}: identityPath`);
      const findings = legacyFileWriteHits(source, file);
      const identityWrites = findings.filter((finding) => finding === "identity.json write");
      const expectedCount = expectedHostileWriterCounts.get(fileName);
      if (expectedCount !== undefined) {
        seenHostileWriters.add(fileName);
        if (identityWrites.length !== expectedCount) {
          hits.push(`${fileName}: expected ${expectedCount} hostile identity writer, found ${identityWrites.length}`);
        }
      } else {
        for (const finding of identityWrites) hits.push(`${fileName}: ${finding}`);
      }
      for (const finding of findings.filter((finding) => finding !== "identity.json write")) {
        hits.push(`${fileName}: ${finding}`);
      }
    }
    for (const file of maintainedFiles(join(process.cwd(), "tests"), new Set([".json"]))) {
      const fileName = relative(process.cwd(), file);
      const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      const identityLike = ["fullName", "updatedAt", "icp", "freeAxes"].some((key) => key in record);
      if (identityLike) hits.push(`${fileName}: flat identity JSON fixture`);
      if ("identity" in record || record.schema_version !== undefined) {
        const parsed = configJsonSchemaV2.safeParse(record);
        if (!parsed.success) hits.push(`${fileName}: invalid schema-v2 config fixture`);
      }
    }
    assert.deepEqual([...seenHostileWriters].sort(), [...expectedHostileWriterCounts.keys()].sort());
    assert.deepEqual(hits, []);
  });

  it("T-NO-ID-LEGACY.9: retired unified-runtime skips are absent while the exact two current-host Windows skips remain", () => {
    // Given every maintained test and hostile syntax variants; When skip predicates are parsed; Then only the exact two current Windows-host owners remain.
    const identityTest = readFileSync(join(process.cwd(), "tests/persistence/identity.mock.test.ts"), "utf8");
    assert.doesNotMatch(identityTest, /T-IW\.2|test\.skip/);
    assert.equal(existsSync(join(process.cwd(), "tests/build/build-runtime.test.ts")), false);
    const sources = maintainedTsFiles(join(process.cwd(), "tests"))
      .filter((file) => file.endsWith(".test.ts"))
      .map((file) => ({
        path: relative(process.cwd(), file).replaceAll("\\", "/"),
        source: readFileSync(file, "utf8"),
      }));
    assertExactCurrentHostSkips(sources);

    const quoteWhitespace = `it('T-WIN7.Runtime.2: when bundled node reports ABI 137, buildRuntimeWindows fails before npm ci', { 'skip': process . platform !== 'win32' }, () => {});`;
    assert.deepEqual(currentHostSkipInventory([{ path: expectedCurrentHostSkips[0]!.path, source: quoteWhitespace }]), [
      expectedCurrentHostSkips[0],
    ]);
    const aliased = `const onlyOnWindows = process.platform !== "win32"; it("${expectedCurrentHostSkips[1]!.title}", { skip: onlyOnWindows }, () => {});`;
    assert.deepEqual(currentHostSkipInventory([{ path: expectedCurrentHostSkips[1]!.path, source: aliased }]), [
      expectedCurrentHostSkips[1],
    ]);
    const third = `it("T-HOSTILE: third current-host skip", { skip: process.platform !== "win32" }, () => {});`;
    assert.throws(
      () => assertExactCurrentHostSkips([...sources, { path: "tests/hostile-third.test.ts", source: third }]),
      /Expected values to be strictly deep-equal/,
    );
    const unresolved = `const windowsOnly = process.platform.startsWith("win"); it("T-HOSTILE: unresolved", { skip: windowsOnly }, () => {});`;
    assert.throws(
      () => currentHostSkipInventory([{ path: "tests/hostile-unresolved.test.ts", source: unresolved }]),
      /unresolved process\.platform-derived skip predicate/,
    );
    assert.doesNotMatch(sources.map(({ source }) => source).join("\n"), /T-DEFCRED\.5/);
  });
});
