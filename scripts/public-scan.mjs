#!/usr/bin/env node
// P-OPEN-SOURCE-SPLIT — exported-surface publication scanner (CI secret-scan).
//
// Mirrors exportProjects' production scan semantics exactly: classifies every
// repository path and scans only App/Web non-test bytes, so private evidence
// (docs, live smokes), core instruction files and negative-assertion test
// carriers never fail the gate. Exits non-zero on any finding. The scan covers
// the same surface the exporter ships — never the private evidence checkout.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyProjectPath, scanProjectText } from "./project-manifest.ts";

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      files.push(...walk(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

let failed = false;
for (const file of walk(process.cwd())) {
  const rel = file.replaceAll("\\", "/").replace(/^\.\//, "");
  if (rel.startsWith("tests/") || rel.includes("/tests/")) continue;
  const owner = classifyProjectPath(rel);
  if (owner !== "app" && owner !== "web") continue;
  const findings = scanProjectText(rel, readFileSync(file, "utf8"));
  if (findings.length > 0) {
    console.error(rel, JSON.stringify(findings));
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
