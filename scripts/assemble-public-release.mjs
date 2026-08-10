#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CANONICAL_FILES = [
  "Frondose.dmg",
  "Frondose.app.tar.gz",
  "Frondose.app.tar.gz.sig",
  "Frondose.nsis.exe",
  "Frondose.nsis.exe.sig",
  "latest.json",
  "SHA256SUMS",
  "sbom.cdx.json",
  "provenance.json",
];

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function exactFile(root, expectedName, pattern) {
  const matches = readdirSync(root).filter((name) => pattern.test(name));
  if (matches.length !== 1 || matches[0] !== expectedName) {
    throw new Error(`expected exactly ${expectedName} in ${root}; found ${matches.join(", ") || "none"}`);
  }
  return join(root, matches[0]);
}

function assertDigest(path, expected, label) {
  if (!/^[0-9a-f]{64}$/.test(expected ?? "") || sha256(path) !== expected) {
    throw new Error(`verified producer digest mismatch for ${label}`);
  }
}

export async function assemblePublicRelease({
  macosRoot,
  windowsRoot,
  outputRoot,
  version,
  repository,
  verifiedSourceSha256,
}) {
  version = version.replace(/^v/, "");
  const macDmg = existsSync(join(macosRoot, "Frondose.dmg"))
    ? exactFile(macosRoot, "Frondose.dmg", /^Frondose\.dmg$/)
    : exactFile(macosRoot, `Frondose_${version}_universal.dmg`, /^Frondose_.*\.dmg$/);
  const macArchive = exactFile(macosRoot, "Frondose.app.tar.gz", /^Frondose.*\.tar\.gz$/);
  const macSignature = exactFile(macosRoot, "Frondose.app.tar.gz.sig", /^Frondose.*\.tar\.gz\.sig$/);
  const windowsExe = existsSync(join(windowsRoot, "Frondose.nsis.exe"))
    ? exactFile(windowsRoot, "Frondose.nsis.exe", /^Frondose\.nsis\.exe$/)
    : exactFile(windowsRoot, `Frondose_${version}_x64-setup.exe`, /^Frondose_.*\.exe$/);
  const windowsSignature = existsSync(join(windowsRoot, "Frondose.nsis.exe.sig"))
    ? exactFile(windowsRoot, "Frondose.nsis.exe.sig", /^Frondose\.nsis\.exe\.sig$/)
    : exactFile(windowsRoot, `Frondose_${version}_x64-setup.exe.sig`, /^Frondose_.*_x64-setup\.exe\.sig$/);
  assertDigest(macDmg, verifiedSourceSha256?.dmg, "macOS DMG");
  assertDigest(macArchive, verifiedSourceSha256?.appTar, "macOS updater archive");
  assertDigest(windowsExe, verifiedSourceSha256?.windowsExe, "Windows NSIS installer");

  const staging = `${resolve(outputRoot)}.staging`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    for (const [source, name] of [
      [macDmg, "Frondose.dmg"],
      [macArchive, "Frondose.app.tar.gz"],
      [macSignature, "Frondose.app.tar.gz.sig"],
      [windowsExe, "Frondose.nsis.exe"],
      [windowsSignature, "Frondose.nsis.exe.sig"],
    ]) {
      cpSync(source, join(staging, name));
    }
    const baseUrl = `https://github.com/${repository}/releases/latest/download`;
    const macUpdaterSignature = readFileSync(join(staging, "Frondose.app.tar.gz.sig"), "utf8").trim();
    const windowsUpdaterSignature = readFileSync(join(staging, "Frondose.nsis.exe.sig"), "utf8").trim();
    const latest = {
      version,
      notes: `Frondose ${version}`,
      pub_date: new Date(0).toISOString(),
      platforms: {
        "darwin-x86_64": { url: `${baseUrl}/Frondose.app.tar.gz`, signature: macUpdaterSignature },
        "darwin-aarch64": { url: `${baseUrl}/Frondose.app.tar.gz`, signature: macUpdaterSignature },
        "windows-x86_64": { url: `${baseUrl}/Frondose.nsis.exe`, signature: windowsUpdaterSignature },
      },
    };
    writeFileSync(join(staging, "latest.json"), `${JSON.stringify(latest, null, 2)}\n`);
    const checksummed = CANONICAL_FILES.slice(0, 5);
    writeFileSync(
      join(staging, "SHA256SUMS"),
      `${checksummed.map((name) => `${sha256(join(staging, name))}  ${name}`).join("\n")}\n`,
    );
    execFileSync("npm", ["exec", "--offline", "--", "cyclonedx-npm", "--output-file", join(staging, "sbom.cdx.json")], {
      cwd: resolve(fileURLToPath(new URL("..", import.meta.url))),
      stdio: "pipe",
    });
    writeFileSync(
      join(staging, "provenance.json"),
      `${JSON.stringify(
        {
          predicateType: "https://slsa.dev/provenance/v1",
          source: { repository, version },
          verifiedProducerSha256: verifiedSourceSha256,
          subjects: checksummed.map((name) => ({ name, sha256: sha256(join(staging, name)) })),
        },
        null,
        2,
      )}\n`,
    );
    const sha256ByFile = Object.fromEntries(CANONICAL_FILES.map((name) => [name, sha256(join(staging, name))]));
    for (const list of ["attestation-subjects.txt", "draft-inputs.txt"]) {
      writeFileSync(join(staging, list), `${CANONICAL_FILES.join("\n")}\n`);
    }
    rmSync(outputRoot, { recursive: true, force: true });
    cpSync(staging, outputRoot, { recursive: true });
    return {
      files: [...CANONICAL_FILES],
      sha256: sha256ByFile,
      attestationSubjects: [...CANONICAL_FILES],
      draftInputs: [...CANONICAL_FILES],
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const manifestPath = process.env.FRONDOSE_VERIFIED_PRODUCER_MANIFEST;
  if (!manifestPath || !existsSync(manifestPath)) throw new Error("FRONDOSE_VERIFIED_PRODUCER_MANIFEST is required");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  await assemblePublicRelease({
    macosRoot: process.env.FRONDOSE_MACOS_PRODUCER_DIR,
    windowsRoot: process.env.FRONDOSE_WINDOWS_PRODUCER_DIR,
    outputRoot: process.env.FRONDOSE_PUBLIC_OUTPUT_DIR,
    version: process.env.FRONDOSE_RELEASE_VERSION,
    repository: process.env.GITHUB_REPOSITORY,
    verifiedSourceSha256: manifest.sha256,
  });
}
