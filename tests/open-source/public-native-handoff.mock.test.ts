import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

type PolicyResult = { ok: boolean; findings: Array<{ kind: string; path?: string; message: string }> };
type ReleasePolicyModule = {
  inspectReleaseCandidate(root: string, canaries: string[]): Promise<PolicyResult>;
  verifyUpdaterSignatures(
    root: string,
    publicKey: string,
    tools?: { run(command: string, args: string[]): Promise<{ status: number; stdout: string; stderr: string }> },
  ): Promise<PolicyResult>;
  inspectPlatformSignatures(
    root: string,
    tools?: { run(command: string, args: string[]): Promise<{ status: number; stdout: string; stderr: string }> },
  ): Promise<PolicyResult>;
};

const REPO = process.cwd();
const POLICY = join(REPO, "scripts", "public-release-policy.mjs");

/** Decode the checked-in Tauri updater public key (critic round-2 B2: exact operand, no wildcard). */
function decodeUpdaterPublicKey(): string {
  const conf = JSON.parse(readFileSync(join(REPO, "src", "tauri", "src-tauri", "tauri.conf.json"), "utf8")) as {
    plugins?: { updater?: { pubkey?: string } };
  };
  const base64 = conf.plugins?.updater?.pubkey ?? "";
  const lines = Buffer.from(base64, "base64").toString("utf8").trim().split(/\r?\n/);
  return lines[lines.length - 1] ?? "";
}

async function loadRepoContext(): Promise<{ tauriConf: { publicKey: string } }> {
  return { tauriConf: { publicKey: decodeUpdaterPublicKey() } };
}

const temporaryDirectories: string[] = [];

function missingGateInputs(...names: string[]): false | string {
  const missing = names.filter((name) => !process.env[name]);
  return missing.length === 0 ? false : `external gate inputs missing: ${missing.join(", ")}`;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

function run(command: string, args: string[]) {
  return spawnSync(command, args, { encoding: "utf8" });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("one exact artifact set reaches inspection, attestation and draft", () => {
  it(
    "T-OS.Release.1c: the real updater EXE pair is required and cryptographically byte-bound",
    { skip: missingGateInputs("FRONDOSE_PUBLIC_SIGNED_FIXTURE_DIR") },
    async () => {
      // Given a real signed candidate, when either updater side is renamed, omitted, substituted, mismatched or zip-shaped, then inspection rejects it.
      const fixture = process.env.FRONDOSE_PUBLIC_SIGNED_FIXTURE_DIR;
      assert.ok(fixture, "set FRONDOSE_PUBLIC_SIGNED_FIXTURE_DIR to real native-signed Tauri outputs");
      const policy = (await import(`${pathToFileURL(POLICY).href}?native-pair`)) as ReleasePolicyModule;
      assert.deepEqual(await policy.inspectReleaseCandidate(fixture, []), { ok: true, findings: [] });
      for (const mutation of [
        "missing-exe",
        "missing-exe-sig",
        "renamed-exe",
        "renamed-exe-sig",
        "substituted-exe",
        "foreign-exe-sig",
        "foreign-mac-sig",
        "stale-latest-url",
        "wrong-latest-signature",
        "missing-checksum",
        "missing-provenance",
        "missing-sbom",
        "zip-reintroduced",
      ]) {
        const root = await temporaryDirectory(`frondose-native-pair-${mutation}-`);
        await cp(fixture, root, { recursive: true });
        const mutator = join(REPO, "tests", "fixtures", "public-release", "mutate-candidate.mjs");
        const changed = run(process.execPath, [mutator, mutation, root]);
        assert.equal(changed.status, 0, `${mutation}: ${changed.stderr}`);
        assert.equal((await policy.inspectReleaseCandidate(root, [])).ok, false, mutation);
      }
    },
  );

  it("T-OS.Release.1d: the pinned updater key verifies each exact archive-sidecar pair", async () => {
    // Given both updater archives and sidecars, when Tauri verification sees a changed key, sidecar, archive or command failure, then that exact pair is red.
    const policy = (await import(`${pathToFileURL(POLICY).href}?updater-crypto`)) as ReleasePolicyModule;
    for (const mutation of [
      "green",
      "changed-key",
      "mac-archive",
      "mac-signature",
      "windows-exe",
      "windows-signature",
      "command-failure",
    ] as const) {
      const root = await temporaryDirectory(`frondose-updater-crypto-${mutation}-`);
      await writeFile(join(root, "Frondose.app.tar.gz"), "mac archive bytes\n");
      await writeFile(join(root, "Frondose.app.tar.gz.sig"), "mac signature bytes\n");
      await writeFile(join(root, "Frondose-windows-x86_64-setup.exe"), "windows installer bytes\n");
      await writeFile(join(root, "Frondose-windows-x86_64-setup.exe.sig"), "windows signature bytes\n");
      const publicKey = mutation === "changed-key" ? "changed-public-key" : "pinned-public-key";
      if (mutation === "mac-archive") await writeFile(join(root, "Frondose.app.tar.gz"), "changed mac bytes\n");
      if (mutation === "mac-signature")
        await writeFile(join(root, "Frondose.app.tar.gz.sig"), "foreign mac signature\n");
      if (mutation === "windows-exe") await writeFile(join(root, "Frondose-windows-x86_64-setup.exe"), "changed windows bytes\n");
      if (mutation === "windows-signature")
        await writeFile(join(root, "Frondose-windows-x86_64-setup.exe.sig"), "foreign windows signature\n");
      const commands: string[] = [];
      const result = await policy.verifyUpdaterSignatures(root, publicKey, {
        async run(command, args) {
          commands.push(`${command} ${args.join(" ")}`);
          const isMac = args.some((arg) => arg.endsWith("Frondose.app.tar.gz"));
          const changed =
            mutation === "changed-key" ||
            mutation === "command-failure" ||
            ((mutation === "mac-archive" || mutation === "mac-signature") && isMac) ||
            ((mutation === "windows-exe" || mutation === "windows-signature") && !isMac);
          return { status: changed ? 1 : 0, stdout: "", stderr: changed ? `injected ${mutation}` : "" };
        },
      });
      assert.equal(result.ok, mutation === "green", mutation);
      assert.deepEqual(commands, [
        `verify-updater-signature ${publicKey} ${join(root, "Frondose.app.tar.gz")} ${join(root, "Frondose.app.tar.gz.sig")}`,
        ...(["green", "windows-exe", "windows-signature"].includes(mutation)
          ? [
              `verify-updater-signature ${publicKey} ${join(root, "Frondose-windows-x86_64-setup.exe")} ${join(root, "Frondose-windows-x86_64-setup.exe.sig")}`,
            ]
          : []),
      ]);
    }
  });

  it("T-OS.Release.4b: empty, partial, unsigned-updater or tree-mismatched candidates fail native verification", async () => {
    // Given exact native candidates and observable platform commands, when one native operation fails, then its own finding blocks promotion.
    const policy = (await import(`${pathToFileURL(POLICY).href}?native-verifier`)) as ReleasePolicyModule;
    for (const partial of ["empty", "app-only", "dmg-only", "exe-only"] as const) {
      const root = await temporaryDirectory(`frondose-native-partial-${partial}-`);
      if (partial === "app-only") await mkdir(join(root, "Frondose.app", "Contents"), { recursive: true });
      if (partial === "dmg-only") await writeFile(join(root, "Frondose-universal.dmg"), "dmg");
      if (partial === "exe-only") await writeFile(join(root, "Frondose-windows-x86_64-setup.exe"), "exe");
      const commands: string[] = [];
      const result = await policy.inspectPlatformSignatures(root, {
        async run(command, args) {
          commands.push(`${command} ${args.join(" ")}`);
          return { status: 0, stdout: "", stderr: "" };
        },
      });
      assert.equal(result.ok, false, partial);
      assert.ok(
        result.findings.some((finding) => finding.kind === "signed_candidate"),
        partial,
      );
      assert.deepEqual(commands, [], `${partial} must fail before native commands`);
    }
    for (const mutation of ["codesign", "mounted-app", "minisign", "updater-pair"] as const) {
      const root = await temporaryDirectory(`frondose-native-operation-${mutation}-`);
      const app = join(root, "Frondose.app");
      await mkdir(join(app, "Contents", "Resources"), { recursive: true });
      await writeFile(join(app, "Contents", "Resources", "payload.txt"), "verified app bytes\n");
      await writeFile(join(root, "Frondose-universal.dmg"), "fixture dmg bytes\n");
      await writeFile(join(root, "Frondose-windows-x86_64-setup.exe"), "fixture exe bytes\n");
      // Updater pairs are REQUIRED members under the ad-hoc + minisign contract (critic BLOCKER-1):
      // ordinary mutations carry complete pairs; only the "updater-pair" mutation removes one member.
      await writeFile(join(root, "Frondose.app.tar.gz"), "fixture updater archive\n");
      await writeFile(join(root, "Frondose.app.tar.gz.sig"), "fixture updater signature\n");
      await writeFile(join(root, "Frondose-windows-x86_64-setup.exe.sig"), "fixture exe signature\n");
      if (mutation === "updater-pair") {
        await rm(join(root, "Frondose.app.tar.gz.sig"));
      }
      const commands: string[] = [];
      const result = await policy.inspectPlatformSignatures(root, {
        async run(command, args) {
          const invocation = `${command} ${args.join(" ")}`;
          commands.push(invocation);
          if (command === "hdiutil" && args[0] === "attach") {
            const mountPoint = args.at(args.indexOf("-mountpoint") + 1);
            assert.ok(mountPoint, "mountpoint must be supplied to hdiutil attach");
            await cp(app, join(mountPoint, "Frondose.app"), { recursive: true });
            if (mutation === "mounted-app") {
              await writeFile(join(mountPoint, "Frondose.app", "Contents", "Resources", "payload.txt"), "different\n");
            }
          }
          const fails =
            (mutation === "codesign" && command === "codesign") ||
            (mutation === "minisign" && command === "verify-updater-signature");
          if (command === "verify-updater-signature" && mutation === "updater-pair") {
            throw new Error("updater-pair mutation must fail before the verifier runs");
          }
          return { status: fails ? 1 : 0, stdout: "", stderr: fails ? `injected ${mutation} failure` : "" };
        },
      });
      assert.equal(result.ok, false, mutation);
      const findingNeedle =
        mutation === "mounted-app"
          ? "mounted app"
          : mutation === "updater-pair"
            ? "updater"
            : mutation === "minisign"
              ? "updater signature"
              : mutation;
      assert.ok(
        result.findings.some((finding) => finding.message.toLowerCase().includes(findingNeedle)),
        mutation,
      );
      const requiredCommand = {
        codesign: "codesign --verify --deep --strict",
        "mounted-app": "hdiutil attach",
        minisign: "verify-updater-signature",
        "updater-pair": "verify-updater-signature",
      }[mutation];
      if (mutation === "minisign") {
        const invocation = commands.find((command) => command.startsWith("verify-updater-signature"));
        assert.ok(invocation, `${mutation} must invoke the updater verifier`);
        // Exact ordered operands: decoded checked-in public key, archive path, signature path
        // (critic round-2 B2: no wildcard key, absolute paths accepted).
        const { tauriConf } = await loadRepoContext();
        const archivePath = join(root, "Frondose.app.tar.gz");
        const sigPath = join(root, "Frondose.app.tar.gz.sig");
        const expected = `verify-updater-signature ${tauriConf.publicKey} ${archivePath} ${sigPath}`;
        assert.equal(invocation, expected, "verifier operands must be EXACT: decoded key + absolute archive + absolute sig");
      }
      if (mutation === "updater-pair") {
        assert.ok(
          !commands.some((command) => command.startsWith("verify-updater-signature")),
          "updater-pair mutation must fail the required-member check BEFORE the verifier runs",
        );
      }
      if (mutation !== "updater-pair") {
        assert.ok(
          commands.some((command) => command.includes(requiredCommand)),
          mutation,
        );
      }
      if (commands.some((command) => command.includes("hdiutil attach"))) {
        assert.ok(
          commands.some((command) => command.includes("hdiutil detach")),
          `${mutation} must detach in finally`,
        );
      }
    }
  });
});
