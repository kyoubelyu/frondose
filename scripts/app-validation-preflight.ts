import { existsSync, readFileSync, statSync } from "node:fs";
import { request } from "node:http";
import { basename, resolve } from "node:path";

export type EvidenceClassification =
  | "compiled-app-preflight"
  | "generated-asset-preflight"
  | "sidecar-implementation-smoke"
  | "release-drift-warning"
  | "rejected-product-route";

export type EvidenceStatus = "pass" | "fail" | "warning";

export type EvidenceItem = {
  classification: EvidenceClassification;
  status: EvidenceStatus;
  message: string;
  details?: Record<string, unknown>;
};

export type PreflightReport = {
  ok: boolean;
  items: EvidenceItem[];
};

type CompiledAppFreshInput = {
  appJsMtimeMs?: number;
  sourceMtimeMs?: number;
  sourcePath?: string;
  appJsPath?: string;
  sourcePaths?: string[];
};

type CompiledAppLoadInput = {
  scriptSrc?: string;
  indexHtmlPath?: string;
  indexHtml?: string;
};

type GeneratedOverlayFreshInput = {
  artifactPath: string;
  expectedBytes?: string;
  actualBytes?: string;
  sourceMtimeMs?: number;
  artifactMtimeMs?: number;
};

type SidecarProvenanceInput = {
  artifactPath: string;
  contents?: string;
  routeArtifactPaths?: string[];
  routeContents?: Record<string, string>;
};

type ClassifyEvidenceInput = {
  route?: string;
  classification?: string;
  purpose?: string;
  markerOnly?: boolean;
  status?: EvidenceStatus;
  message?: string;
  details?: Record<string, unknown>;
};

type SidecarHealthInput = {
  healthResponse?: { ok: boolean; ts: number; pid: number };
  socketPath?: string;
  token?: string;
  timeoutMs?: number;
};

type ReleaseDriftInput = {
  packageVersion?: string;
  tauriVersion?: string;
  cargoVersion?: string;
  updaterVersion?: string;
  packageJsonPath?: string;
  tauriConfigPath?: string;
  cargoTomlPath?: string;
  latestJsonPath?: string;
};

type RunPreflightOptions = {
  items?: EvidenceItem[];
  allowDrift?: boolean;
  root?: string;
  noSidecarSmoke?: boolean;
  sidecarHealth?: SidecarHealthInput;
};

const PRODUCT_ACCEPTANCE_PURPOSES = new Set([
  "product-acceptance",
  "compiled-app-acceptance",
  "generated-overlay-acceptance",
]);

const DIRECT_CLI_ROUTES = new Set(["bin: mai", "mai", "./dist/index.js", "dist/index.js", "dist/cli/main.js"]);

function item(
  classification: EvidenceClassification,
  status: EvidenceStatus,
  message: string,
  details?: Record<string, unknown>,
): EvidenceItem {
  return details === undefined ? { classification, status, message } : { classification, status, message, details };
}

function isProductAcceptancePurpose(purpose: string | undefined): boolean {
  return purpose !== undefined && PRODUCT_ACCEPTANCE_PURPOSES.has(purpose);
}

function isDirectCliRoute(route: string | undefined): boolean {
  if (route === undefined) return false;
  const normalized = route.replace(/^\.\//, "");
  return DIRECT_CLI_ROUTES.has(route) || DIRECT_CLI_ROUTES.has(normalized);
}

function isKnownClassification(value: string | undefined): value is EvidenceClassification {
  return (
    value === "compiled-app-preflight" ||
    value === "generated-asset-preflight" ||
    value === "sidecar-implementation-smoke" ||
    value === "release-drift-warning" ||
    value === "rejected-product-route"
  );
}

function readJsonVersion(filePath: string): string | undefined {
  if (!existsSync(filePath)) return undefined;
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { version?: unknown };
  return typeof parsed.version === "string" ? parsed.version : undefined;
}

function readCargoVersion(filePath: string): string | undefined {
  if (!existsSync(filePath)) return undefined;
  const text = readFileSync(filePath, "utf8");
  const packageSection = text.match(/\[package\][\s\S]*?(?:\n\[|$)/)?.[0] ?? "";
  return packageSection.match(/\nversion\s*=\s*"([^"]+)"/)?.[1];
}

function newestMtimeMs(paths: string[]): { mtimeMs: number; path?: string; missing: string[] } {
  let mtimeMs = 0;
  let path: string | undefined;
  const missing: string[] = [];
  for (const candidate of paths) {
    if (!existsSync(candidate)) {
      missing.push(candidate);
      continue;
    }
    const candidateMtimeMs = statSync(candidate).mtimeMs;
    if (candidateMtimeMs > mtimeMs) {
      mtimeMs = candidateMtimeMs;
      path = candidate;
    }
  }
  return { mtimeMs, path, missing };
}

function parseScriptSrcs(html: string): string[] {
  const matches = html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi);
  return Array.from(matches, (match) => match[1]).filter((src): src is string => src !== undefined);
}

export function classifyEvidence(input: ClassifyEvidenceInput): EvidenceItem {
  if (input.markerOnly && isProductAcceptancePurpose(input.purpose)) {
    return item(
      "rejected-product-route",
      "fail",
      "Marker-only dist evidence cannot satisfy compiled-app or generated overlay acceptance evidence.",
      { route: input.route, purpose: input.purpose },
    );
  }

  if (isProductAcceptancePurpose(input.purpose) && isDirectCliRoute(input.route)) {
    return item(
      "rejected-product-route",
      "fail",
      `Direct CLI/dist route ${input.route} cannot satisfy product acceptance; use the compiled Frondose app/Tauri path.`,
      { route: input.route, purpose: input.purpose },
    );
  }

  if (isKnownClassification(input.classification)) {
    return item(input.classification, input.status ?? "pass", input.message ?? "Evidence classified.", input.details);
  }

  return item(
    "sidecar-implementation-smoke",
    input.status ?? "pass",
    input.message ?? "Implementation evidence recorded.",
    {
      route: input.route,
      purpose: input.purpose,
    },
  );
}

export function assertCompiledAppFresh(input: CompiledAppFreshInput): EvidenceItem {
  const appJsPath = input.appJsPath ?? "src/tauri/ui/app.js";
  let appJsMtimeMs = input.appJsMtimeMs;
  let sourceMtimeMs = input.sourceMtimeMs;
  let sourcePath = input.sourcePath;

  if (appJsMtimeMs === undefined) {
    if (!existsSync(appJsPath)) {
      return item(
        "compiled-app-preflight",
        "fail",
        `Compiled Tauri UI ${appJsPath} is missing; run npm run build:tauri-ui or npm run build:tauri.`,
        { appJsPath },
      );
    }
    appJsMtimeMs = statSync(appJsPath).mtimeMs;
  }

  if (sourceMtimeMs === undefined) {
    const sourcePaths = input.sourcePaths ?? [
      "src/tauri/ui/app.ts",
      "src/tauri/ui/frondoseTokens.ts",
      "src/tauri/ui/mode.ts",
      "src/tauri/ui/render.ts",
      "src/tauri/ui/settings.ts",
      "src/tauri/ui/index.html",
    ];
    const newest = newestMtimeMs(sourcePaths);
    sourceMtimeMs = newest.mtimeMs;
    sourcePath = newest.path ?? sourcePath;
  }

  if (sourceMtimeMs > appJsMtimeMs) {
    return item(
      "compiled-app-preflight",
      "fail",
      `Compiled Tauri UI is stale relative to ${sourcePath ?? "a UI source"}; run npm run build:tauri-ui or npm run build:tauri.`,
      { appJsPath, appJsMtimeMs, sourcePath, sourceMtimeMs },
    );
  }

  return item("compiled-app-preflight", "pass", "Compiled Tauri UI app.js is fresh for app delivery.", {
    appJsPath,
    appJsMtimeMs,
    sourcePath,
    sourceMtimeMs,
  });
}

export function assertCompiledAppLoad(input: CompiledAppLoadInput): EvidenceItem {
  const scriptSrcs =
    input.scriptSrc !== undefined
      ? [input.scriptSrc]
      : parseScriptSrcs(
          input.indexHtml ??
            readFileSync(input.indexHtmlPath ?? "src/tauri/ui/index.html", {
              encoding: "utf8",
            }),
        );

  if (scriptSrcs.some((src) => src.endsWith("app.ts"))) {
    return item(
      "rejected-product-route",
      "fail",
      "Source-route app.ts execution is rejected; compiled app delivery must load ./app.js.",
      { scriptSrcs },
    );
  }

  if (scriptSrcs.includes("./app.js") || scriptSrcs.includes("app.js")) {
    return item("compiled-app-preflight", "pass", "Compiled Tauri app load evidence uses ./app.js.", { scriptSrcs });
  }

  return item(
    "compiled-app-preflight",
    "fail",
    "Compiled Tauri app load evidence did not find ./app.js; app.ts or marker-only routes cannot satisfy compiled evidence.",
    { scriptSrcs },
  );
}

export function assertGeneratedOverlayFresh(input: GeneratedOverlayFreshInput): EvidenceItem {
  const actualBytes =
    input.actualBytes ?? (existsSync(input.artifactPath) ? readFileSync(input.artifactPath, "utf8") : undefined);

  if (actualBytes === undefined) {
    return item(
      "generated-asset-preflight",
      "fail",
      `Generated overlay artifact ${input.artifactPath} is missing; run npm run build:overlay-assets or npm run build:tauri.`,
      { artifactPath: input.artifactPath },
    );
  }

  if (input.expectedBytes !== undefined && actualBytes !== input.expectedBytes) {
    return item(
      "generated-asset-preflight",
      "fail",
      `Generated overlay artifact ${input.artifactPath} is stale; run npm run build:overlay-assets or npm run build:tauri.`,
      { artifactPath: input.artifactPath },
    );
  }

  if (input.sourceMtimeMs !== undefined) {
    const artifactMtimeMs =
      input.artifactMtimeMs ??
      (existsSync(input.artifactPath) ? statSync(input.artifactPath).mtimeMs : Number.NEGATIVE_INFINITY);
    if (input.sourceMtimeMs > artifactMtimeMs) {
      return item(
        "generated-asset-preflight",
        "fail",
        `Generated overlay artifact ${input.artifactPath} is older than overlay sources; run npm run build:overlay-assets or npm run build:tauri.`,
        { artifactPath: input.artifactPath, artifactMtimeMs, sourceMtimeMs: input.sourceMtimeMs },
      );
    }
  }

  return item("generated-asset-preflight", "pass", `Generated overlay artifact ${input.artifactPath} is fresh.`, {
    artifactPath: input.artifactPath,
  });
}

export function assertSidecarProvenance(input: SidecarProvenanceInput): EvidenceItem {
  const contents = input.contents ?? (existsSync(input.artifactPath) ? readFileSync(input.artifactPath, "utf8") : "");
  const entrypointMarkers = ["serve", "--sock", "--token"];
  const entrypointMissing = entrypointMarkers.filter((marker) => !contents.includes(marker));

  if (contents.length === 0) {
    return item(
      "sidecar-implementation-smoke",
      "fail",
      `Temporary app-owned sidecar artifact ${input.artifactPath} is missing or empty.`,
      { artifactPath: input.artifactPath },
    );
  }

  const routeArtifactEvidence = collectRouteArtifactEvidence(input);
  const hasHealthRoute = contents.includes("/health") || routeArtifactEvidence.some((evidence) => evidence.hasHealthRoute);

  if (entrypointMissing.length > 0 || !hasHealthRoute) {
    return item(
      "sidecar-implementation-smoke",
      "fail",
      "Temporary app-owned sidecar evidence is missing app sidecar protocol markers; this is not product acceptance.",
      {
        artifactPath: input.artifactPath,
        entrypointMissing,
        routeMissing: hasHealthRoute ? [] : ["/health"],
        routeArtifacts: routeArtifactEvidence,
      },
    );
  }

  return item(
    "sidecar-implementation-smoke",
    "pass",
    "Temporary app-owned sidecar provenance passed; this is implementation smoke only, not product acceptance.",
    { artifactPath: input.artifactPath, routeArtifacts: routeArtifactEvidence },
  );
}

function collectRouteArtifactEvidence(input: SidecarProvenanceInput): Array<{ artifactPath: string; hasHealthRoute: boolean }> {
  return (input.routeArtifactPaths ?? []).map((artifactPath) => {
    const contents =
      input.routeContents?.[artifactPath] ?? (existsSync(artifactPath) ? readFileSync(artifactPath, "utf8") : "");
    return { artifactPath, hasHealthRoute: contents.includes("/health") && contents.includes("pid: process.pid") };
  });
}

export async function smokeSidecarHealth(input: SidecarHealthInput): Promise<EvidenceItem> {
  if (input.healthResponse !== undefined) {
    const health = input.healthResponse;
    if (health.ok === true && Number.isFinite(health.ts) && Number.isFinite(health.pid)) {
      return item(
        "sidecar-implementation-smoke",
        "pass",
        "Sidecar /health readiness passed; this is health evidence only.",
        { health },
      );
    }
    return item("sidecar-implementation-smoke", "fail", "Sidecar /health readiness response was not ok.", { health });
  }

  if (input.socketPath === undefined || input.token === undefined) {
    return item(
      "sidecar-implementation-smoke",
      "fail",
      "Sidecar /health smoke requires a mocked healthResponse or socketPath plus token.",
    );
  }

  return smokeUnixHealth(input.socketPath, input.token, input.timeoutMs ?? 2000);
}

export function detectReleaseDrift(input: ReleaseDriftInput): EvidenceItem[] {
  const packageVersion = input.packageVersion ?? readJsonVersion(input.packageJsonPath ?? "package.json");
  const tauriVersion =
    input.tauriVersion ?? readJsonVersion(input.tauriConfigPath ?? "src/tauri/src-tauri/tauri.conf.json");
  const cargoVersion = input.cargoVersion ?? readCargoVersion(input.cargoTomlPath ?? "src/tauri/src-tauri/Cargo.toml");
  const updaterVersion = input.updaterVersion ?? readJsonVersion(input.latestJsonPath ?? "website/latest.json");
  const versions = { packageVersion, tauriVersion, cargoVersion, updaterVersion };
  const present = Object.entries(versions).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  if (present.length < 2) return [];

  const uniqueVersions = new Set(present.map(([, version]) => version));
  if (uniqueVersions.size <= 1) return [];

  return [
    item(
      "release-drift-warning",
      "warning",
      "Package/Tauri/Cargo/updater version drift is warning-only in P-APP-3; P-APP-10 owns release identity.",
      versions,
    ),
  ];
}

export async function runAppValidationPreflight(input: RunPreflightOptions = {}): Promise<PreflightReport> {
  const items = input.items ?? (await collectDefaultEvidence(input));
  const ok = items.every((evidence) => {
    if (evidence.status !== "fail") return true;
    if (input.allowDrift && evidence.classification === "release-drift-warning") return true;
    return false;
  });
  return { ok, items };
}

async function collectDefaultEvidence(input: RunPreflightOptions): Promise<EvidenceItem[]> {
  const root = input.root ?? process.cwd();
  const fromRoot = (path: string) => resolve(root, path);
  const overlaySources = newestMtimeMs([
    fromRoot("src/overlay/bootstrap.ts"),
    fromRoot("src/overlay/bootstrapTakeover.ts"),
    fromRoot("src/overlay/cssTransform.ts"),
    fromRoot("src/overlay/sharedEntry.ts"),
    fromRoot("src/overlay/sharedRender.ts"),
    fromRoot("src/tauri/ui/index.html"),
    fromRoot("src/tauri/ui/render.ts"),
  ]);

  const items: EvidenceItem[] = [
    assertCompiledAppFresh({
      appJsPath: fromRoot("src/tauri/ui/app.js"),
      sourcePaths: [
        fromRoot("src/tauri/ui/app.ts"),
        fromRoot("src/tauri/ui/frondoseTokens.ts"),
        fromRoot("src/tauri/ui/mode.ts"),
        fromRoot("src/tauri/ui/render.ts"),
        fromRoot("src/tauri/ui/settings.ts"),
        fromRoot("src/tauri/ui/index.html"),
      ],
    }),
    assertCompiledAppLoad({ indexHtmlPath: fromRoot("src/tauri/ui/index.html") }),
    assertGeneratedOverlayFresh({
      artifactPath: fromRoot("src/overlay/frondoseCss.generated.ts"),
      sourceMtimeMs: overlaySources.mtimeMs,
    }),
    assertGeneratedOverlayFresh({
      artifactPath: fromRoot("src/overlay/sharedRenderBundle.generated.ts"),
      sourceMtimeMs: overlaySources.mtimeMs,
    }),
    assertSidecarProvenance({
      artifactPath: fromRoot("dist/cli/main.js"),
      routeArtifactPaths: [
        fromRoot("dist/cli/subcommands/serve.js"),
        fromRoot("dist/cli/subcommands/serve/routes.js"),
      ],
    }),
    ...detectReleaseDrift({
      packageJsonPath: fromRoot("package.json"),
      tauriConfigPath: fromRoot("src/tauri/src-tauri/tauri.conf.json"),
      cargoTomlPath: fromRoot("src/tauri/src-tauri/Cargo.toml"),
      latestJsonPath: fromRoot("website/latest.json"),
    }),
  ];

  if (!input.noSidecarSmoke && input.sidecarHealth !== undefined) {
    items.push(await smokeSidecarHealth(input.sidecarHealth));
  }

  return items;
}

function smokeUnixHealth(socketPath: string, token: string, timeoutMs: number): Promise<EvidenceItem> {
  return new Promise((resolveItem) => {
    const req = request(
      {
        socketPath,
        path: "/health",
        method: "GET",
        timeout: timeoutMs,
        headers: { Authorization: `Bearer ${token}` },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            resolveItem(
              item("sidecar-implementation-smoke", "fail", `Sidecar /health returned HTTP ${res.statusCode}.`, {
                socketPath,
                statusCode: res.statusCode,
              }),
            );
            return;
          }
          try {
            const parsed = JSON.parse(body) as { ok?: unknown; ts?: unknown; pid?: unknown };
            resolveItem(
              parsed.ok === true
                ? item(
                    "sidecar-implementation-smoke",
                    "pass",
                    "Sidecar /health readiness passed; this is health evidence only.",
                    { socketPath, health: parsed },
                  )
                : item("sidecar-implementation-smoke", "fail", "Sidecar /health returned a non-ok body.", {
                    socketPath,
                    body,
                  }),
            );
          } catch {
            resolveItem(
              item("sidecar-implementation-smoke", "fail", "Sidecar /health returned invalid JSON.", {
                socketPath,
                body,
              }),
            );
          }
        });
      },
    );

    req.on("timeout", () => {
      req.destroy();
      resolveItem(item("sidecar-implementation-smoke", "fail", "Sidecar /health readiness timed out.", { socketPath }));
    });
    req.on("error", (error: Error) => {
      resolveItem(
        item("sidecar-implementation-smoke", "fail", `Sidecar /health readiness failed: ${error.message}`, {
          socketPath,
        }),
      );
    });
    req.end();
  });
}

function printTextReport(report: PreflightReport): void {
  const status = report.ok ? "PASS" : "FAIL";
  process.stdout.write(`[app-validation-preflight] ${status}\n`);
  for (const evidence of report.items) {
    process.stdout.write(`- ${evidence.status} ${evidence.classification}: ${evidence.message}\n`);
  }
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const report = await runAppValidationPreflight({ noSidecarSmoke: args.has("--no-sidecar-smoke") });
  if (args.has("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printTextReport(report);
  }
  process.exitCode = report.ok ? 0 : 1;
}

const invokedPath = process.argv[1] === undefined ? "" : basename(process.argv[1]);
if (invokedPath === "app-validation-preflight.ts" || invokedPath === "app-validation-preflight.js") {
  await main();
}
