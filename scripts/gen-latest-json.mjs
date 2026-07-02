#!/usr/bin/env node
// P-58d.2 / WIN-5 — generate the Tauri updater latest.json. The universal
// macOS .app.tar.gz is exposed under both darwin keys; the Windows NSIS updater
// artifact is exposed under windows-x86_64 when supplied. Build-layer tooling
// (CLAUDE.md HR-8): NOT a src/tools/** change, never invoked by the agent.
//
// Env: VERSION (required), OUT_PATH (required), PUB_DATE (optional, RFC3339),
//      NOTES (optional).
//      macOS:   SIG_PATH + MANIFEST_URL (optional pair)
//      Windows: WINDOWS_SIG_PATH + WINDOWS_MANIFEST_URL (optional pair)
import { readFileSync, writeFileSync } from "node:fs";

const sigPath = process.env.SIG_PATH;
const version = (process.env.VERSION ?? "").replace(/^v/, "");
const url = process.env.MANIFEST_URL;
const outPath = process.env.OUT_PATH;
const windowsSigPath = process.env.WINDOWS_SIG_PATH ?? process.env.WIN_SIG_PATH;
const windowsUrl = process.env.WINDOWS_MANIFEST_URL ?? process.env.WIN_MANIFEST_URL;

if (!version || !outPath) {
  console.error("[gen-latest-json] missing required env: VERSION, OUT_PATH");
  process.exit(1);
}
if ((sigPath && !url) || (!sigPath && url)) {
  console.error("[gen-latest-json] macOS env must be supplied as a pair: SIG_PATH + MANIFEST_URL");
  process.exit(1);
}
if ((windowsSigPath && !windowsUrl) || (!windowsSigPath && windowsUrl)) {
  console.error("[gen-latest-json] Windows env must be supplied as a pair: WINDOWS_SIG_PATH + WINDOWS_MANIFEST_URL");
  process.exit(1);
}
if (!sigPath && !windowsSigPath) {
  console.error("[gen-latest-json] missing platform artifact env: provide macOS and/or Windows sig+url pair");
  process.exit(1);
}

const pubDate = process.env.PUB_DATE ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const notes = process.env.NOTES ?? `Frondose ${version}`;
const platforms = {};

if (sigPath && url) {
  const signature = readFileSync(sigPath, "utf8");
  const platform = { url, signature };
  platforms["darwin-x86_64"] = platform;
  platforms["darwin-aarch64"] = platform;
}

if (windowsSigPath && windowsUrl) {
  platforms["windows-x86_64"] = {
    url: windowsUrl,
    signature: readFileSync(windowsSigPath, "utf8"),
  };
}

const manifest = {
  version,
  notes,
  pub_date: pubDate,
  platforms,
};

writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[gen-latest-json] wrote ${outPath} (version ${version})`);
