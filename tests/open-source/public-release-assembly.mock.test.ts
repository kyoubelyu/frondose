import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

type PolicyResult = { ok: boolean; findings: Array<{ kind: string; path?: string; message: string }> };
type ReleaseManifest = {
  files: string[];
  sha256: Record<string, string>;
  attestationSubjects: string[];
  draftInputs: string[];
};
type ReleasePolicyModule = {
  validatePublicReleaseHandoff(root: string, workflow: string): Promise<PolicyResult>;
};
type AssemblerModule = {
  assemblePublicRelease(input: {
    macosRoot: string;
    windowsRoot: string;
    outputRoot: string;
    version: string;
    repository: string;
    verifiedSourceSha256: { dmg: string; appTar: string; windowsExe: string };
  }): Promise<ReleaseManifest>;
};

const REPO = process.cwd();
const POLICY = join(REPO, "scripts", "public-release-policy.mjs");
const ASSEMBLER = join(REPO, "scripts", "assemble-public-release.mjs");
const CANONICAL_FILES = [
  "Frondose-universal.dmg",
  "Frondose.app.tar.gz",
  "Frondose.app.tar.gz.sig",
  "Frondose-windows-x86_64-setup.exe",
  "Frondose-windows-x86_64-setup.exe.sig",
  "latest.json",
  "SHA256SUMS",
  "sbom.cdx.json",
  "provenance.json",
];
const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

async function readOrEmpty(path: string): Promise<string> {
  return readFile(path, "utf8").catch(() => "");
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function createProducerFixture(): Promise<{
  macos: string;
  windows: string;
  verifiedSourceSha256: { dmg: string; appTar: string; windowsExe: string };
}> {
  const root = await temporaryDirectory("frondose-public-producers-");
  const macos = join(root, "macos");
  const windows = join(root, "windows");
  await mkdir(macos, { recursive: true });
  await mkdir(windows, { recursive: true });
  const dmg = join(macos, "Frondose_0.5.19_universal.dmg");
  const appTar = join(macos, "Frondose.app.tar.gz");
  const exe = join(windows, "Frondose_0.5.19_x64-setup.exe");
  await writeFile(dmg, "verified dmg bytes\n");
  await writeFile(appTar, "verified updater tar bytes\n");
  await writeFile(`${appTar}.sig`, "updater signature over tar bytes\n");
  await writeFile(exe, "authenticode verified installer bytes\n");
  await writeFile(`${exe}.sig`, "updater signature over installer bytes\n");
  return {
    macos,
    windows,
    verifiedSourceSha256: { dmg: await sha256(dmg), appTar: await sha256(appTar), windowsExe: await sha256(exe) },
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("one exact artifact set is preserved by production assembly", () => {
  it("T-OS.Release.6: production assembly preserves exact names and byte hashes through both output lists", async () => {
    // Given real producer directories, when normalization and metadata run, then one nine-file manifest supplies byte-identical attestation and draft inputs.
    const producer = await createProducerFixture();
    const outputRoot = await temporaryDirectory("frondose-public-assembly-");
    const assembler = (await import(`${pathToFileURL(ASSEMBLER).href}?assembly`)) as AssemblerModule;
    const manifest = await assembler.assemblePublicRelease({
      macosRoot: producer.macos,
      windowsRoot: producer.windows,
      outputRoot,
      version: "0.5.19",
      repository: "kyoubelyu/frondose",
      verifiedSourceSha256: producer.verifiedSourceSha256,
    });
    assert.deepEqual(manifest.files, CANONICAL_FILES);
    assert.deepEqual(manifest.attestationSubjects, CANONICAL_FILES);
    assert.deepEqual(manifest.draftInputs, CANONICAL_FILES);
    assert.deepEqual(
      (await readFile(join(outputRoot, "attestation-subjects.txt"), "utf8")).trim().split("\n"),
      CANONICAL_FILES,
    );
    assert.deepEqual(
      (await readFile(join(outputRoot, "draft-inputs.txt"), "utf8")).trim().split("\n"),
      CANONICAL_FILES,
    );
    for (const file of CANONICAL_FILES) assert.equal(manifest.sha256[file], await sha256(join(outputRoot, file)), file);
    assert.equal(await sha256(join(outputRoot, "Frondose-windows-x86_64-setup.exe")), producer.verifiedSourceSha256.windowsExe);
    const latest = JSON.parse(await readFile(join(outputRoot, "latest.json"), "utf8"));
    assert.deepEqual(Object.keys(latest.platforms), ["darwin-x86_64", "darwin-aarch64", "windows-x86_64"]);
    for (const platform of ["darwin-x86_64", "darwin-aarch64"]) {
      assert.equal(
        latest.platforms[platform].url,
        "https://github.com/kyoubelyu/frondose/releases/latest/download/Frondose.app.tar.gz",
      );
      assert.equal(
        latest.platforms[platform].signature,
        (await readFile(join(outputRoot, "Frondose.app.tar.gz.sig"), "utf8")).trim(),
      );
    }
    assert.equal(
      latest.platforms["windows-x86_64"].url,
      "https://github.com/kyoubelyu/frondose/releases/latest/download/Frondose-windows-x86_64-setup.exe",
    );
    assert.equal(
      latest.platforms["windows-x86_64"].signature,
      (await readFile(join(outputRoot, "Frondose-windows-x86_64-setup.exe.sig"), "utf8")).trim(),
    );
    const policy = (await import(`${pathToFileURL(POLICY).href}?release-handoff`)) as ReleasePolicyModule;
    const workflow = await readFile(join(REPO, ".github", "workflows", "release.yml"), "utf8");
    assert.deepEqual(await policy.validatePublicReleaseHandoff(outputRoot, workflow), { ok: true, findings: [] });
    for (const list of ["attestation-subjects.txt", "draft-inputs.txt"] as const) {
      const original = await readFile(join(outputRoot, list), "utf8");
      await writeFile(join(outputRoot, list), original.replace("Frondose-windows-x86_64-setup.exe\n", ""));
      assert.equal((await policy.validatePublicReleaseHandoff(outputRoot, workflow)).ok, false, list);
      await writeFile(join(outputRoot, list), original);
    }
    const originalExe = await readFile(join(outputRoot, "Frondose-windows-x86_64-setup.exe"));
    await writeFile(
      join(outputRoot, "Frondose-windows-x86_64-setup.exe"),
      Buffer.concat([originalExe, Buffer.from("post-inspection mutation")]),
    );
    assert.equal(
      (await policy.validatePublicReleaseHandoff(outputRoot, workflow)).ok,
      false,
      "normalized byte substitution",
    );
    await writeFile(join(outputRoot, "Frondose-windows-x86_64-setup.exe"), originalExe);
    for (const mutation of [
      "missing-exe",
      "stale-exe",
      "duplicate-exe",
      "stale-dmg",
      "duplicate-dmg",
      "stale-app-tar",
      "duplicate-exe-signature",
      "post-verify-substitution",
      "missing-mac-signature",
    ] as const) {
      const hostile = await createProducerFixture();
      if (mutation === "missing-exe") await rm(join(hostile.windows, "Frondose_0.5.19_x64-setup.exe"));
      if (mutation === "stale-exe") await writeFile(join(hostile.windows, "Frondose_0.5.18_x64-setup.exe"), "stale\n");
      if (mutation === "duplicate-exe")
        await writeFile(join(hostile.windows, "Frondose_0.5.19_x64-setup-copy.exe"), "duplicate\n");
      if (mutation === "stale-dmg") await writeFile(join(hostile.macos, "Frondose_0.5.18_universal.dmg"), "stale\n");
      if (mutation === "duplicate-dmg")
        await writeFile(join(hostile.macos, "Frondose_0.5.19_universal-copy.dmg"), "duplicate\n");
      if (mutation === "stale-app-tar") await writeFile(join(hostile.macos, "Frondose-old.tar.gz"), "stale\n");
      if (mutation === "duplicate-exe-signature")
        await writeFile(join(hostile.windows, "Frondose_0.5.18_x64-setup.exe.sig"), "stale signature\n");
      if (mutation === "post-verify-substitution")
        await writeFile(join(hostile.windows, "Frondose_0.5.19_x64-setup.exe"), "substituted\n");
      if (mutation === "missing-mac-signature") await rm(join(hostile.macos, "Frondose.app.tar.gz.sig"));
      const hostileOutput = await temporaryDirectory(`frondose-public-assembly-${mutation}-`);
      await assert.rejects(
        () =>
          assembler.assemblePublicRelease({
            macosRoot: hostile.macos,
            windowsRoot: hostile.windows,
            outputRoot: hostileOutput,
            version: "0.5.19",
            repository: "kyoubelyu/frondose",
            verifiedSourceSha256: hostile.verifiedSourceSha256,
          }),
        undefined,
        mutation,
      );
      assert.equal((await readOrEmpty(join(hostileOutput, "draft-inputs.txt"))).trim(), "", mutation);
    }
  });
});
