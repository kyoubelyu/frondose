import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const REQUIRED_FILES = ["dist/overlay/bootstrapTakeover.js", "dist/overlay/bootstrap.js"];
const REQUIRED_MARKERS = ["__frondoseShowWorkflow", "__frondoseShowEdgeRing", "__frondoseShowAgentTarget"];

export function findMissingDistMarkers(root: string = process.cwd()): string[] {
  const missing: string[] = [];
  for (const file of REQUIRED_FILES) {
    if (!existsSync(resolve(root, file))) missing.push(`missing file: ${file}`);
  }

  const overlayDir = resolve(root, "dist/overlay");
  let text = "";
  if (existsSync(overlayDir)) {
    for (const file of readdirSync(overlayDir)) {
      if (file.endsWith(".js")) text += readFileSync(resolve(overlayDir, file), "utf8");
    }
  }

  for (const marker of REQUIRED_MARKERS) {
    if (!text.includes(marker)) missing.push(`missing marker: ${marker}`);
  }
  return missing;
}

function main(): void {
  const missing = findMissingDistMarkers();
  if (missing.length > 0) {
    process.stderr.write(`[assert-dist] FAIL - stale/incomplete dist:\n  ${missing.join("\n  ")}\n`);
    process.exit(1);
  }
  process.stdout.write("[assert-dist] ok - overlay fns present in dist/\n");
}

if (process.argv[1]?.endsWith("assert-dist.js") || process.argv[1]?.endsWith("assert-dist.ts")) {
  main();
}
