import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { DEFAULT_CREDENTIALS_PATH, readDefaultCredentials } from "../../src/persistence/defaultCredentials.js";
import { readSecrets, writeSecrets } from "../../src/persistence/secrets.js";
import { cleanupTmpDir } from "../_helpers/tmp";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GENERATOR_ALLOWED_MODULES = ["node:fs", "node:path"] as const;
const READER_ALLOWED_MODULES = ["node:fs", "node:path", "node:url", "./jsonFile.js"] as const;

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "frondose-default-creds-scope-"));
  return { dir, cleanup: () => cleanupTmpDir(dir) };
}

function credentialAssignments(source: string, allowedModules: readonly string[] = []): string[] {
  const sourceFile = ts.createSourceFile("credential-source.ts", source, ts.ScriptTarget.Latest, true);
  const bindings = new Map<string, ts.Expression>();
  const destinations: Array<{ name: string; expression: ts.Expression }> = [];
  const shadowedBindings: string[] = [];
  const bindingNames = new Set<string>();
  const registerBinding = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      if (bindingNames.has(name.text)) shadowedBindings.push(name.text);
      bindingNames.add(name.text);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) registerBinding(element.name);
    }
  };
  const staticText = (expression: ts.Expression, seen = new Set<string>()): string | undefined => {
    if (ts.isStringLiteralLike(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
    if (ts.isParenthesizedExpression(expression)) return staticText(expression.expression, seen);
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = staticText(expression.left, seen);
      const right = staticText(expression.right, seen);
      return left === undefined || right === undefined ? undefined : left + right;
    }
    if (ts.isIdentifier(expression) && !seen.has(expression.text)) {
      const initializer = bindings.get(expression.text);
      if (!initializer) return undefined;
      const nextSeen = new Set(seen);
      nextSeen.add(expression.text);
      return staticText(initializer, nextSeen);
    }
    if (ts.isTemplateExpression(expression)) {
      let value = expression.head.text;
      for (const span of expression.templateSpans) {
        const resolved = staticText(span.expression, seen);
        if (resolved === undefined) return undefined;
        value += resolved + span.literal.text;
      }
      return value;
    }
    return undefined;
  };

  const collect = (node: ts.Node): void => {
    if (ts.isBindingElement(node) && node.propertyName && !ts.isIdentifier(node.propertyName)) {
      shadowedBindings.push("forbidden-nonidentifier-binding-property");
    }
    if (ts.isPropertyAssignment(node) && !ts.isIdentifier(node.name)) {
      shadowedBindings.push("forbidden-nonidentifier-property");
    }
    if (ts.isImportDeclaration(node)) {
      const moduleName = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : "";
      if (!allowedModules.includes(moduleName)) {
        shadowedBindings.push(`forbidden-module:${moduleName || "dynamic"}`);
      }
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const moduleName = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : "";
      if (!allowedModules.includes(moduleName)) {
        shadowedBindings.push(`forbidden-reexport:${moduleName || "dynamic"}`);
      }
    }
    if (ts.isImportEqualsDeclaration(node)) shadowedBindings.push("forbidden-import-equals");
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      shadowedBindings.push("forbidden-dynamic-import");
    }
    if (
      ts.isIdentifier(node) &&
      /^(?:Object|Reflect|globalThis|constructor|prototype|__proto__|eval|Function|vm|module|require|getBuiltinModule|Script|runInContext|runInNewContext|runInThisContext|compileFunction)$/.test(
        node.text,
      )
    ) {
      shadowedBindings.push(`forbidden-reflective-owner:${node.text}`);
    }
    if (ts.isElementAccessExpression(node)) shadowedBindings.push("forbidden-element-access");
    if (ts.isVariableDeclaration(node)) {
      registerBinding(node.name);
      if (ts.isIdentifier(node.name) && node.initializer) bindings.set(node.name.text, node.initializer);
      if (ts.isIdentifier(node.name) && node.initializer && /key|token|secret|credential/i.test(node.name.text)) {
        destinations.push({ name: node.name.text, expression: node.initializer });
      }
    }
    if (ts.isParameter(node)) {
      registerBinding(node.name);
      if (ts.isIdentifier(node.name) && node.initializer) bindings.set(node.name.text, node.initializer);
    }
    if (ts.isCatchClause(node) && node.variableDeclaration) registerBinding(node.variableDeclaration.name);
    if (ts.isImportClause(node)) {
      if (node.name) registerBinding(node.name);
      if (node.namedBindings && ts.isNamespaceImport(node.namedBindings)) registerBinding(node.namedBindings.name);
      if (node.namedBindings && ts.isNamedImports(node.namedBindings)) {
        for (const element of node.namedBindings.elements) registerBinding(element.name);
      }
    }
    if (ts.isPropertyAssignment(node)) {
      const name =
        ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)
          ? node.name.text
          : ts.isComputedPropertyName(node.name)
            ? (staticText(node.name.expression) ?? "dynamicCredentialDestination")
            : "";
      if (/key|token|secret|credential/i.test(name)) destinations.push({ name, expression: node.initializer });
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Object" &&
      node.expression.name.text === "defineProperty"
    ) {
      const name = node.arguments[1] ? (staticText(node.arguments[1]) ?? "dynamicCredentialDestination") : "";
      const descriptor = node.arguments[2];
      if (/key|token|secret|credential/i.test(name) && descriptor && ts.isObjectLiteralExpression(descriptor)) {
        const valueProperty = descriptor.properties.find(
          (property): property is ts.PropertyAssignment =>
            ts.isPropertyAssignment(property) &&
            (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) &&
            property.name.text === "value",
        );
        if (valueProperty) destinations.push({ name, expression: valueProperty.initializer });
        else shadowedBindings.push("dynamicCredentialDestination");
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const name = ts.isPropertyAccessExpression(node.left)
        ? node.left.name.text
        : ts.isElementAccessExpression(node.left)
          ? (staticText(node.left.argumentExpression) ?? "dynamicCredentialDestination")
          : "";
      if (/key|token|secret|credential/i.test(name)) destinations.push({ name, expression: node.right });
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  type Constant = string | Constant[] | Record<string, Constant>;
  const resolveConstant = (expression: ts.Expression, seen = new Set<string>()): Constant | undefined => {
    if (
      ts.isStringLiteralLike(expression) ||
      ts.isNoSubstitutionTemplateLiteral(expression) ||
      ts.isNumericLiteral(expression)
    ) {
      return expression.text;
    }
    if (ts.isParenthesizedExpression(expression)) return resolveConstant(expression.expression, seen);
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = resolveConstant(expression.left, seen);
      const right = resolveConstant(expression.right, seen);
      return typeof left === "string" && typeof right === "string" ? left + right : undefined;
    }
    if (ts.isIdentifier(expression) && !seen.has(expression.text)) {
      const initializer = bindings.get(expression.text);
      if (!initializer) return undefined;
      const nextSeen = new Set(seen);
      nextSeen.add(expression.text);
      return resolveConstant(initializer, nextSeen);
    }
    if (ts.isArrayLiteralExpression(expression)) {
      const values = expression.elements.map((entry) => resolveConstant(entry, seen));
      return values.every((value) => value !== undefined) ? (values as Constant[]) : undefined;
    }
    if (ts.isObjectLiteralExpression(expression)) {
      const value: Record<string, Constant> = {};
      for (const property of expression.properties) {
        if (!ts.isPropertyAssignment(property)) return undefined;
        const name =
          ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)
            ? property.name.text
            : ts.isComputedPropertyName(property.name)
              ? resolveConstant(property.name.expression, seen)
              : undefined;
        const resolved = resolveConstant(property.initializer, seen);
        if (typeof name !== "string" || resolved === undefined) return undefined;
        value[name] = resolved;
      }
      return value;
    }
    if (ts.isPropertyAccessExpression(expression)) {
      const owner = resolveConstant(expression.expression, seen);
      return owner && !Array.isArray(owner) && typeof owner === "object" ? owner[expression.name.text] : undefined;
    }
    if (ts.isElementAccessExpression(expression)) {
      const owner = resolveConstant(expression.expression, seen);
      const key = resolveConstant(expression.argumentExpression, seen);
      if (Array.isArray(owner) && typeof key === "string" && /^\d+$/.test(key)) return owner[Number(key)];
      return owner && !Array.isArray(owner) && typeof owner === "object" && typeof key === "string"
        ? owner[key]
        : undefined;
    }
    if (
      ts.isCallExpression(expression) &&
      ts.isPropertyAccessExpression(expression.expression) &&
      expression.expression.name.text === "join"
    ) {
      const owner = resolveConstant(expression.expression.expression, seen);
      const separator = expression.arguments.length === 0 ? "," : resolveConstant(expression.arguments[0], seen);
      return Array.isArray(owner) && owner.every((entry) => typeof entry === "string") && typeof separator === "string"
        ? owner.join(separator)
        : undefined;
    }
    if (ts.isTemplateExpression(expression)) {
      let value = expression.head.text;
      for (const span of expression.templateSpans) {
        const resolved = resolveConstant(span.expression, seen);
        if (typeof resolved !== "string") return undefined;
        value += resolved + span.literal.text;
      }
      return value;
    }
    return undefined;
  };

  return [
    ...shadowedBindings.map((name) => `shadowed-binding:${name}`),
    ...destinations
      .map(({ name, expression }) => {
        const value = resolveConstant(expression);
        return typeof value === "string" && value.length >= 16 ? `${name}:${value}` : undefined;
      })
      .filter((value): value is string => value !== undefined),
  ];
}

function executeGeneratorInSandbox(source: string): {
  envReads: string[];
  writes: Array<{ path: string; content: string; encoding: string | undefined }>;
} {
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const envReads: string[] = [];
  const writes: Array<{ path: string; content: string; encoding: string | undefined }> = [];
  const envValues: Record<string, string> = {
    FRONDOSE_DEFAULT_LLM_BASEURL: "https://llm.example.test/v1",
    FRONDOSE_DEFAULT_LLM_MODEL: "provider:model/test-1",
    FRONDOSE_DEFAULT_LLM_KEY: "sk-test_!@#$%^&*()-+=:punctuation",
  };
  const env = new Proxy(envValues, {
    get(target, property) {
      if (typeof property === "string") envReads.push(property);
      return Reflect.get(target, property);
    },
    ownKeys(target) {
      envReads.push("<ownKeys>");
      return Reflect.ownKeys(target);
    },
    has(target, property) {
      if (typeof property === "string") envReads.push(property);
      return Reflect.has(target, property);
    },
    getOwnPropertyDescriptor(target, property) {
      if (typeof property === "string") envReads.push(property);
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
  const processStub = {
    cwd: () => "/virtual/frondose",
    env,
    stderr: { write: () => true },
  };
  const fsStub = {
    existsSync: () => false,
    mkdirSync: () => undefined,
    writeFileSync: (path: string, content: string, encoding?: string) => writes.push({ path, content, encoding }),
  };
  const moduleStub = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(output, {
    console: { log: () => undefined },
    exports: moduleStub.exports,
    module: moduleStub,
    process: processStub,
    require: (specifier: string) => {
      if (specifier === "node:fs") return fsStub;
      if (specifier === "node:path") return { resolve: (...parts: string[]) => parts.join("/") };
      throw new Error(`unexpected generator dependency: ${specifier}`);
    },
  });
  return { envReads, writes };
}

describe("P-WEB-SEARCH-MCP-SCOPE embedded default credentials", { concurrency: 1 }, () => {
  // Given the production no-argument reader seam, when its path resolves, then it remains co-located with this module.
  it("T-MCP-SCOPE.7h: zero-argument reader resolves the co-located generated sidecar", () => {
    const expectedPath = join(REPO, "src", "persistence", "defaultCredentials.generated.json");
    assert.equal(DEFAULT_CREDENTIALS_PATH(), expectedPath);
    assert.deepEqual(readDefaultCredentials(), readDefaultCredentials(expectedPath));
  });

  // Given generated JSON with three LLM defaults plus a stale Brave field, when read, then only the three current fields survive.
  it("T-MCP-SCOPE.7i: default-credential reader exposes exactly the three LLM fields", () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = join(dir, "defaults.json");
      writeFileSync(
        path,
        JSON.stringify({
          llmBaseUrl: "https://llm.example/v1",
          llmModel: "deepseek-chat",
          llmKey: "llm-key",
          braveKey: "stale-brave",
        }),
      );
      assert.deepEqual(readDefaultCredentials(path), {
        llmBaseUrl: "https://llm.example/v1",
        llmModel: "deepseek-chat",
        llmKey: "llm-key",
      });
      assert.deepEqual(readDefaultCredentials(join(dir, "missing.json")), {
        llmBaseUrl: null,
        llmModel: null,
        llmKey: null,
      });
      const corruptPath = join(dir, "corrupt.json");
      writeFileSync(corruptPath, "{not-json");
      assert.deepEqual(readDefaultCredentials(corruptPath), {
        llmBaseUrl: null,
        llmModel: null,
        llmKey: null,
      });
      const blankPath = join(dir, "blank.json");
      writeFileSync(blankPath, JSON.stringify({ llmBaseUrl: " ", llmModel: "\t", llmKey: "" }));
      assert.deepEqual(readDefaultCredentials(blankPath), {
        llmBaseUrl: null,
        llmModel: null,
        llmKey: null,
      });
    } finally {
      cleanup();
    }
  });

  // Given DeepSeek and reserved official-host defaults, when first-run seeds, then DeepSeek is named correctly and reserved hosts are refused.
  it("T-MCP-SCOPE.7j2: three-field seeding preserves provider-scope classification", () => {
    for (const fixture of [
      {
        baseUrl: "https://api.deepseek.com/v1",
        expectedProvider: "deepseek",
      },
      {
        baseUrl: "https://api.openai.com/v1",
        expectedProvider: null,
      },
      {
        baseUrl: "https://api.anthropic.com/v1",
        expectedProvider: null,
      },
    ]) {
      const { dir, cleanup } = tempDir();
      try {
        const defaultsPath = join(dir, "defaults.json");
        writeFileSync(
          defaultsPath,
          JSON.stringify({ llmBaseUrl: fixture.baseUrl, llmModel: "model", llmKey: "llm-key" }),
        );
        const loaded = readSecrets(join(dir, "secrets.json"), { defaultCredentialsPath: defaultsPath });
        if (fixture.expectedProvider) {
          assert.equal(loaded.providers?.[fixture.expectedProvider]?.key, "llm-key");
          assert.equal(loaded.default, `${fixture.expectedProvider}:model`);
        } else {
          assert.deepEqual(loaded.providers ?? {}, {});
          assert.equal(loaded.default, undefined);
        }
        assert.equal(loaded.search, undefined);
      } finally {
        cleanup();
      }
    }
  });

  // Given first-run defaults containing a stale Brave field, when secrets seed, then LLM seeds and search remains absent.
  it("T-MCP-SCOPE.7j: first-run default seeding never creates search.braveApiKey", () => {
    const { dir, cleanup } = tempDir();
    try {
      const defaultsPath = join(dir, "defaults.json");
      const secretsPath = join(dir, "secrets.json");
      writeFileSync(
        defaultsPath,
        JSON.stringify({
          llmBaseUrl: "https://llm.example/v1",
          llmModel: "model",
          llmKey: "llm-key",
          braveKey: "stale-brave",
        }),
      );
      const seeded = readSecrets(secretsPath, { defaultCredentialsPath: defaultsPath });
      assert.equal(seeded.providers?.custom?.key, "llm-key");
      assert.equal(seeded.default, "custom:model");
      assert.equal(seeded.search, undefined);
      assert.equal(JSON.parse(readFileSync(secretsPath, "utf8")).search, undefined);
    } finally {
      cleanup();
    }
  });

  // Given no secrets, legacy files, or generated defaults, when readSecrets runs, then it preserves the schema-bearing empty state without writing a file.
  it("T-MCP-SCOPE.7j1: absent defaults preserve no-write first-run behavior", () => {
    const { dir, cleanup } = tempDir();
    try {
      const secretsPath = join(dir, "secrets.json");
      const loaded = readSecrets(secretsPath, { defaultCredentialsPath: join(dir, "missing-defaults.json") });
      assert.deepEqual(loaded, { schema_version: 1 });
      assert.equal(existsSync(secretsPath), false);
    } finally {
      cleanup();
    }
  });

  // Given existing current search data and stale embedded Brave defaults, when read/backfill runs, then operator data is unchanged.
  it("T-MCP-SCOPE.7k: default backfill preserves existing current search data and never adds provider search", () => {
    const { dir, cleanup } = tempDir();
    try {
      const defaultsPath = join(dir, "defaults.json");
      const secretsPath = join(dir, "secrets.json");
      writeSecrets(
        {
          schema_version: 1,
          default: "deepseek:deepseek-chat",
          visionModel: "custom:vision-model",
          providers: {
            deepseek: { key: "operator-key", baseUrl: "https://api.deepseek.com/v1", type: "openai" },
            custom: { key: "operator-custom-key", baseUrl: "https://llm.example.test/v1", type: "openai" },
          },
          search: {
            braveApiKey: "legacy-operator-brave",
            tavilyApiKey: "legacy-operator-tavily",
          },
          github: { token: "operator-github-token", repo: "operator/private-repo" },
          server: { token: "operator-server-token", webToken: "operator-web-token" },
        },
        secretsPath,
      );
      writeFileSync(
        defaultsPath,
        JSON.stringify({
          llmBaseUrl: "https://ignored.example/v1",
          llmModel: "ignored",
          llmKey: "ignored",
          braveKey: "stale-brave",
        }),
      );
      const beforeBytes = readFileSync(secretsPath, "utf8");
      const beforeObject = JSON.parse(beforeBytes);
      const loaded = readSecrets(secretsPath, { defaultCredentialsPath: defaultsPath });
      assert.deepEqual(loaded, beforeObject);
      assert.ok(!JSON.stringify(loaded).includes("stale-brave"));
      assert.equal(readFileSync(secretsPath, "utf8"), beforeBytes);
    } finally {
      cleanup();
    }
  });

  // Given the generator, when source is scanned, then exactly the three LLM env inputs exist and no Brave input remains.
  it("T-MCP-SCOPE.7l: default generator has no Brave input", () => {
    const generator = readFileSync(join(REPO, "scripts", "gen-default-credentials.ts"), "utf8");
    const reader = readFileSync(join(REPO, "src", "persistence", "defaultCredentials.ts"), "utf8");
    const canonicalEnvAccess = /process\.env\.(FRONDOSE_DEFAULT_[A-Z0-9_]+)/g;
    const defaultEnvFields = [...generator.matchAll(canonicalEnvAccess)].map((match) => match[1]);
    assert.deepEqual(defaultEnvFields.sort(), [
      "FRONDOSE_DEFAULT_LLM_BASEURL",
      "FRONDOSE_DEFAULT_LLM_KEY",
      "FRONDOSE_DEFAULT_LLM_MODEL",
    ]);
    const withoutCanonicalEnvAccess = generator.replace(canonicalEnvAccess, "");
    assert.doesNotMatch(
      withoutCanonicalEnvAccess,
      /\bprocess\s*(?:\.env|\[\s*["']env["']\s*\])|=\s*process\.env\b/,
      "generator must not use bracket, destructured, aliased, or dynamic environment access",
    );
    assert.deepEqual(
      [...new Set([...generator.matchAll(/\bFRONDOSE_DEFAULT_[A-Z0-9_]+\b/g)].map((match) => match[0]))].sort(),
      ["FRONDOSE_DEFAULT_LLM_BASEURL", "FRONDOSE_DEFAULT_LLM_KEY", "FRONDOSE_DEFAULT_LLM_MODEL"],
    );
    assert.doesNotMatch(generator, /FRONDOSE_DEFAULT_BRAVE_KEY|braveKey/);
    const gitignore = readFileSync(join(REPO, ".gitignore"), "utf8");
    assert.match(gitignore, /defaultCredentials\.generated\.json/);
    const tracked = execFileSync("git", ["ls-files", "src/persistence/defaultCredentials.generated.json"], {
      cwd: REPO,
      encoding: "utf8",
    }).trim();
    assert.equal(tracked, "");
    assert.doesNotMatch(
      `${generator}\n${reader}`,
      /(?:sk-|bsa_|tvly-|ghp_|Bearer )[A-Za-z0-9_-]{12,}/,
      "generator and reader must not contain direct or indirect credential-shaped literals",
    );
    const longQuotedLiterals = [...`${generator}\n${reader}`.matchAll(/["'`]([A-Za-z0-9_=-]{24,})["'`]/g)]
      .map((match) => match[1])
      .filter((value) => !value.startsWith("FRONDOSE_") && value !== "defaultCredentials.generated.json");
    assert.deepEqual(
      longQuotedLiterals,
      [],
      "generator and reader must not hide long credential literals in variables",
    );
    assert.deepEqual(
      [
        ...credentialAssignments(generator, GENERATOR_ALLOWED_MODULES),
        ...credentialAssignments(reader, READER_ALLOWED_MODULES),
      ],
      [],
      "key/token/secret destinations must not resolve direct, indirect, or split credential literals",
    );
    const acquisitionMutations = [
      'const destination=["llm","Key"].join(""); const secret=["sk-punct_!@#$%^&*()", "-credential"].join(""); const value = {[destination]: secret};',
      'const destination=["llm","Key"].join(""); const secret=["sk-punct_!@#$%^&*()", "-credential"].join(""); Object.defineProperty({}, destination, {value: secret});',
      'const parts=["sk-punct_!@#$%^&*()", "-credential"]; const assembled=parts.join(""); const define=Object.defineProperty; define({}, ["llm","Key"].join(""), {value: assembled});',
      'const parts=["sk-punct_!@#$%^&*()", "-credential"]; const assembled=parts.join(""); globalThis["Reflect"]["defineProperty"]({}, ["llm","Key"].join(""), {value: assembled});',
      'const parts=["sk-punct_!@#$%^&*()", "-credential"]; const assembled=parts.join(""); const define=({}).constructor["defineProperty"]; define({}, ["llm","Key"].join(""), {value: assembled});',
      'const parts=["sk-punct_!@#$%^&*()", "-credential"]; const assembled=parts.join(""); const owner=({}).constructor; owner["defineProperty"]({}, ["llm","Key"].join(""), {value: assembled});',
      'import vm from "node:vm"; const parts=["sk-punct_!@#$%^&*()", "-credential"]; const assembled=parts.join(""); vm.runInNewContext("void 0", {assembled});',
      'export {Script as Runner} from "node:vm";',
      'export * from "node:vm";',
      'const runtime=import("node:vm");',
      'const runtime=require("node:vm");',
      'const loader=module.require; const runtime=loader("node:vm");',
      'const {["run"+"InNewContext"]:execute}=process.getBuiltinModule("node:"+"vm"); execute("void 0", {});',
      'const runtime=process.getBuiltinModule("node:vm"); const Runner=runtime.Script; const task=new Runner("void 0"); task.runInContext({});',
      'const {["get"+"BuiltinModule"]:load}=process; const runtime=load("node:"+"vm"); const {["Scr"+"ipt"]:Runner}=runtime; const task=new Runner("void 0"); const {["run"+"InContext"]:execute}=task; execute({});',
      'let load,runtime,Runner,task,execute; ({["get"+"BuiltinModule"]:load}=process); runtime=load("node:"+"vm"); ({["Scr"+"ipt"]:Runner}=runtime); task=new Runner("void 0"); ({["run"+"InContext"]:execute}=task); execute({});',
      'const {"getBuiltinModule":load}=process; const runtime=load("node:"+"vm"); const {"Script":Runner,"createContext":makeContext}=runtime; const task=new Runner("globalThis.proof=42"); const {"runInContext":execute}=task; const context=makeContext({}); execute.call(task,context);',
      'let load,runtime,Runner,makeContext,task,execute; ({"getBuiltinModule":load}=process); runtime=load("node:"+"vm"); ({"Script":Runner,"createContext":makeContext}=runtime); task=new Runner("globalThis.proof=42"); ({"runInContext":execute}=task); const context=makeContext({}); execute.call(task,context);',
    ];
    for (const [owner, allowedModules] of [
      ["generator", GENERATOR_ALLOWED_MODULES],
      ["reader", READER_ALLOWED_MODULES],
    ] as const) {
      for (const mutation of acquisitionMutations) {
        assert.ok(
          credentialAssignments(mutation, allowedModules).length > 0,
          `${owner} must fail closed on dynamic credential or module-acquisition mutation`,
        );
      }
    }
    const sandbox = executeGeneratorInSandbox(generator);
    assert.deepEqual(sandbox.envReads.sort(), [
      "FRONDOSE_DEFAULT_LLM_BASEURL",
      "FRONDOSE_DEFAULT_LLM_KEY",
      "FRONDOSE_DEFAULT_LLM_MODEL",
    ]);
    assert.equal(sandbox.writes.length, 2);
    const expectedBytes = `${JSON.stringify(
      {
        _generated: "GENERATED by scripts/gen-default-credentials.ts — DO NOT COMMIT (gitignored).",
        llmBaseUrl: "https://llm.example.test/v1",
        llmModel: "provider:model/test-1",
        llmKey: "sk-test_!@#$%^&*()-+=:punctuation",
      },
      null,
      2,
    )}\n`;
    assert.deepEqual(sandbox.writes, [
      {
        path: "/virtual/frondose/src/persistence/defaultCredentials.generated.json",
        content: expectedBytes,
        encoding: "utf-8",
      },
      {
        path: "/virtual/frondose/dist/persistence/defaultCredentials.generated.json",
        content: expectedBytes,
        encoding: "utf-8",
      },
    ]);
  });
});
