#!/usr/bin/env node
// P-58d.2 — generate the Tauri updater latest.json (Option A: dual darwin-x86_64
// + darwin-aarch64 keys → the SAME universal .app.tar.gz URL + sig). Build-layer
// tooling (CLAUDE.md HR-8): NOT a src/tools/** change, never invoked by the agent.
//
// Env: SIG_PATH (required), VERSION (required), MANIFEST_URL (required),
//      OUT_PATH (required), PUB_DATE (optional, RFC3339), NOTES (optional).
import { readFileSync, writeFileSync } from "node:fs";

const sigPath = process.env.SIG_PATH;
const version = (process.env.VERSION ?? "").replace(/^v/, "");
const url = process.env.MANIFEST_URL;
const outPath = process.env.OUT_PATH;

if (!sigPath || !version || !url || !outPath) {
  console.error("[gen-latest-json] missing required env: SIG_PATH, VERSION, MANIFEST_URL, OUT_PATH");
  process.exit(1);
}

const pubDate = process.env.PUB_DATE ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const notes = process.env.NOTES ?? `Frondose ${version}`;
const signature = readFileSync(sigPath, "utf8");
const platform = { url, signature };

const manifest = {
  version,
  notes,
  pub_date: pubDate,
  platforms: {
    "darwin-x86_64": platform,
    "darwin-aarch64": platform,
  },
};

writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[gen-latest-json] wrote ${outPath} (version ${version})`);
