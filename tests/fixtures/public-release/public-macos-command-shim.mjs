#!/usr/bin/env node
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const [commandArgument, ...args] = process.argv.slice(2);
const command = commandArgument || basename(process.argv[1] ?? "");
const scenario = process.env.FRONDOSE_TEST_SCENARIO ?? "green";
const receipt = process.env.FRONDOSE_TEST_RECEIPT;
if (!receipt) throw new Error("FRONDOSE_TEST_RECEIPT is required");
const redactedValues = new Set(
  [process.env.APPLE_CERTIFICATE_PASSWORD, process.env.APPLE_PASSWORD, process.env.TAURI_SIGNING_PRIVATE_KEY].filter(
    Boolean,
  ),
);
const event = { command, args: args.map((arg) => (redactedValues.has(arg) ? "<redacted>" : arg)) };

if (command === "npx") {
  const configIndex = args.indexOf("--config");
  if (configIndex >= 0) {
    const configPath = args[configIndex + 1];
    event.configPath = configPath;
    event.config = JSON.parse(readFileSync(configPath, "utf8"));
  }
}

if (command === "cargo") {
  const verifier = join(process.env.CARGO_TARGET_DIR, "release", "frondose-updater-verifier");
  mkdirSync(join(process.env.CARGO_TARGET_DIR, "release"), { recursive: true });
  writeFileSync(
    verifier,
    `#!/bin/sh\nexec "${process.execPath}" "${fileURLToPath(import.meta.url)}" "verify-updater-signature" "$@"\n`,
  );
  chmodSync(verifier, 0o755);
}
writeFileSync(receipt, `${JSON.stringify(event)}\n`, { flag: "a" });

const failure =
  (scenario === "codesign-failure" && command === "codesign") ||
  (scenario === "build-failure" && command === "npx") ||
  (scenario === "verifier-failure" && command === "verify-updater-signature");
if (failure) process.exit(1);


if (command === "npx") {
  const target = process.env.CARGO_TARGET_DIR;
  if (!target) throw new Error("CARGO_TARGET_DIR is required");
  const bundle = join(target, "universal-apple-darwin", "release", "bundle");
  const app = join(bundle, "macos", "Frondose.app");
  mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
  writeFileSync(join(app, "Contents", "Resources", "payload.txt"), "public app bytes\n");
  mkdirSync(join(bundle, "dmg"), { recursive: true });
  writeFileSync(join(bundle, "dmg", "Frondose_0.5.19_universal.dmg"), "dmg bytes\n");
  writeFileSync(join(bundle, "macos", "Frondose.app.tar.gz"), "updater tar bytes\n");
  writeFileSync(join(bundle, "macos", "Frondose.app.tar.gz.sig"), "updater signature\n");
}

if (command === "hdiutil" && args[0] === "attach") {
  const mountPoint = args[args.indexOf("-mountpoint") + 1];
  const sourceApp = join(
    process.env.CARGO_TARGET_DIR,
    "universal-apple-darwin",
    "release",
    "bundle",
    "macos",
    "Frondose.app",
  );
  cpSync(sourceApp, join(mountPoint, "Frondose.app"), { recursive: true });
  if (scenario === "mounted-app-mismatch") {
    writeFileSync(
      join(mountPoint, "Frondose.app", "Contents", "Resources", "payload.txt"),
      "different mounted bytes\n",
    );
  }
}
