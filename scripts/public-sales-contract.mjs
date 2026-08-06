#!/usr/bin/env node
// P-OPEN-SOURCE-SPLIT — sales-doctrine carrier inventory.
//
// Discovers every prompt/tool/persistence/UI/generated/test owner of the
// methodology doctrine (marker text, methodology namespace, reverse module
// imports, and source-map sources) and returns an explicit compatibility
// disposition for each. A discovered owner without a reviewed disposition is
// reported as "unreviewed" and blocks publication until dispositioned.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

const MARKERS = ["METHODOLOGY_DISTILLATION", "methodUsed", "R1-open", "pain_chain_lean", "enterprise-mapping"];

// Reviewed real-repository dispositions. Anything discovered outside this map
// is reported as "unreviewed" (a blocker).
const REVIEWED_DISPOSITIONS = new Map([
  // Methodology core
  ["src/methodology/distill.ts", "retain"],
  ["src/methodology/freeAxes.ts", "retain"],
  ["src/methodology/index.ts", "retain"],
  ["src/methodology/types.ts", "retain"],
  ["src/agent/systemPrompt/soul.ts", "retain"],
  // Persistence and tools
  ["src/persistence/sales/scores.ts", "retain"],
  ["src/tools/control/suggestCard.ts", "retain"],
  ["src/tools/identity/identity.ts", "retain"],
  ["src/tools/sales/scoreLead.ts", "retain"],
  ["src/tools/methodology/qualifyProfile.ts", "retain"],
  ["src/tools/index.ts", "retain"],
  ["src/tools/sales/recordRawCandidate.ts", "retain"],
  ["src/tools/sales/promoteCandidateToLead.ts", "retain"],
  // App backend importers
  ["src/app/backend/index.ts", "retain"],
  ["src/app/backend/settings.ts", "retain"],
  ["src/app/backend/cron.ts", "retain"],
  // UI and generated artifacts
  ["src/tauri/ui/settings.ts", "revise-with-stronger-carrier"],
  ["src/tauri/ui/settings.js", "private-excluded"],
  // Carriers
  ["tests/agent/systemPrompt/methodology-repertoire.mock.test.ts", "retain"],
  ["tests/agent/systemPrompt/soul-icp-precision.mock.test.ts", "retain"],
  ["tests/agent/systemPrompt/soul-rhythm.mock.test.ts", "retain"],
  ["tests/agent/systemPrompt/soul.test.ts", "retain"],
  ["tests/agent/systemPrompt/todoEncouragement-pY5.mock.test.ts", "revise-with-stronger-carrier"],
  ["tests/contract/p33-contract.mock.test.ts", "revise-with-stronger-carrier"],
  ["tests/fixtures/test-identity.json", "revise-with-stronger-carrier"],
  ["tests/tauri/ui/settings-collectPatch.mock.test.ts", "revise-with-stronger-carrier"],
  ["tests/tools/control/suggestCard-p57a.mock.test.ts", "retain"],
  ["tests/tools/identity/identity.mock.test.ts", "retain"],
  ["tests/tools/sales/scoreLead.mock.test.ts", "retain"],
  ["tests/tools/sales/sp-d-chain.mock.test.ts", "retain"],
  ["tests/methodology/freeAxes.mock.test.ts", "retain"],
  ["tests/methodology/soul-band.mock.test.ts", "retain"],
  ["tests/sales/soul.test.ts", "retain"],
  ["tests/tauri/ui/app-split-slice11.mock.test.ts", "revise-with-stronger-carrier"],
  // Private live evidence
  ["tests/live/p-sp-b-live.smoke.ts", "private-excluded"],
  ["tests/live/p4-memory-identity.smoke.ts", "private-excluded"],
  ["tests/live/p6-control.smoke.ts", "private-excluded"],
  ["tests/live/evidence/p-sp-b/agent-session.txt", "private-excluded"],
  ["tests/live/evidence/p-y2-magical/app-l1-audit-slice.jsonl", "private-excluded"],
]);

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "target", ".venv"]);

function walk(repository) {
  const files = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
      const full = join(dir, name);
      const stat = statSync(full);
      if (stat.isDirectory()) visit(full);
      else if (stat.isFile()) files.push(full);
    }
  };
  visit(repository);
  return files;
}

function importSpecifiers(file) {
  const text = readFileSync(file, "utf8");
  const specifiers = [];
  for (const match of text.matchAll(
    /(?:from|import)\s*\(\s*["']([^"']+)["']\s*\)|from\s+["']([^"']+)["']|import\s+["']([^"']+)["']/g,
  )) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (spec && (spec.startsWith(".") || spec.startsWith("src/"))) specifiers.push(spec);
  }
  return specifiers;
}

function normalizeModulePath(repoRoot, file, specifier) {
  if (specifier.startsWith("src/")) return specifier.replace(/\.js$/, ".ts");
  const resolved = normalize(join(dirname(join(repoRoot, file)), specifier));
  const repoRelative = relative(repoRoot, resolved).replaceAll("\\", "/");
  return repoRelative.replace(/\.js$/, ".ts");
}

/** Inventory every methodology carrier under the repository with its disposition and discovery reasons. */
export async function inventoryMethodologyCarriers(repository) {
  const repoRoot = resolve(repository);
  const files = walk(repoRoot).map((file) => relative(repoRoot, file).replaceAll("\\", "/"));
  const entries = new Map(); // path -> { path, disposition, discoveredBy }
  const add = (path, reason) => {
    const existing = entries.get(path) ?? {
      path,
      disposition: REVIEWED_DISPOSITIONS.get(path) ?? "unreviewed",
      discoveredBy: [],
    };
    if (!existing.discoveredBy.includes(reason)) existing.discoveredBy.push(reason);
    entries.set(path, existing);
  };
  for (const path of files) {
    const text = readFileSync(join(repoRoot, path), "utf8");
    for (const marker of MARKERS) {
      if (text.includes(marker)) add(path, `marker:${marker}`);
    }
    if (path.includes("/methodology/")) add(path, "path:methodology");
  }
  // Reverse module imports: token-free files that import a discovered carrier.
  let changed = true;
  while (changed) {
    changed = false;
    for (const path of files) {
      if (entries.has(path)) continue;
      const specifiers = importSpecifiers(join(repoRoot, path));
      for (const specifier of specifiers) {
        const target = normalizeModulePath(repoRoot, path, specifier);
        if (entries.has(target)) {
          add(path, `imported-by:${target}`);
          changed = true;
          break;
        }
      }
    }
  }
  // Source maps: the map artifact and every token-free mapped source.
  for (const path of files) {
    if (!path.endsWith(".js.map")) continue;
    const mapPath = join(repoRoot, path);
    let sources = [];
    try {
      sources = JSON.parse(readFileSync(mapPath, "utf8")).sources ?? [];
    } catch {
      sources = [];
    }
    add(path, `source-map:${path}`);
    for (const source of sources) {
      const mapped = normalize(join(dirname(path), source)).replaceAll("\\", "/");
      add(mapped, `source-map:${path}`);
    }
  }
  return [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// CLI entry for the workflow's sales-contract step.
const invokedAsEntrypoint =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedAsEntrypoint) {
  inventoryMethodologyCarriers(process.cwd()).then((inventory) => {
    for (const entry of inventory) {
      process.stdout.write(`${entry.path}\t${entry.disposition}\t${entry.discoveredBy.join(",")}\n`);
    }
  });
}
