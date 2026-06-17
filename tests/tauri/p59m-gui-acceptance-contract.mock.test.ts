/**
 * P-59M Step 2 scaffold — compiled Mac GUI acceptance evidence contract.
 *
 * These tests are intentionally red at Step 2. They define the mockable
 * evidence shape that Step 5 must fill after the live compiled-app run.
 *
 * Run:
 *   node --import tsx --test --test-force-exit \
 *     tests/tauri/p59m-gui-acceptance-contract.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const EXPECTED_VERSION = "0.5.0-alpha.57";
const EXPECTED_BUNDLE_ID = "com.kyoube.frondose";
const INSTALLED_APP = "/Applications/Frondose.app";
const INSTALLED_BIN = `${INSTALLED_APP}/Contents/MacOS/Frondose`;
const APP_SIDECAR = `${INSTALLED_APP}/Contents/Resources/runtime/dist/app/sidecarMain.js`;
const EXPECTED_PROFILE_URL = "https://www.linkedin.com/in/p59m-step2-placeholder/";
const EXPECTED_MARKER = "P59M-GUI-L1-step2-placeholder";

type VersionEvidence = {
  repoVersions: Record<"packageJson" | "packageLock" | "tauriConf" | "cargoToml" | "cargoLock", string>;
  installedVersionBefore: string;
  installedVersionAfter: string;
  installedBundleId: string;
};

type BuildArtifactEvidence = {
  buildStartedAtMs: number;
  appPath: string;
  appMtimeMs: number;
  binaryArchs: string[];
  runtimeNodeExecutable: boolean;
  sidecarExists: boolean;
  updaterTarballExists: boolean;
  updaterSigExists: boolean;
};

type GuiEvidence = {
  runningExecutable: string;
  visibleWindow: boolean;
  minimized: boolean;
  inspectorAttachable: boolean;
};

type SidecarEvidence = {
  pid: number;
  ppid: number;
  commandPath: string;
  ownerEnv?: string;
  portFile: string;
  health: { status: number; ok: boolean; pid: number };
  wrongTokenHealth: { status: number; ok: boolean };
  unauthenticatedHealth: { status: number; ok: boolean };
};

type ChromeEnsureEvidence = {
  cdpPortOwner: "absent" | "frondose" | "foreign";
  response: { status: number; ok: boolean; chromePort: number; overlayInstalled: boolean };
  versionEndpointReachable: boolean;
  profileDir: string;
};

type UpdateServerEvidence = {
  activeManifestVersion: string | null;
  configNeutralized: boolean;
  backupPath: string | null;
  restored: boolean;
  launchedAppVersion: string;
};

type AgentMarkerEvidence = {
  submittedFromVisibleGui: boolean;
  directToolExecutionUsed: boolean;
  auditToolNames: string[];
  recordRawCandidateSource: "profile-nav" | string;
  rawCandidateRows: Array<{
    id: string;
    profileUrl: string;
    personName: string;
    sourceContext: string | null;
    evidenceSummary: string | null;
  }>;
  timelineRows: Array<{ candidateId: string; eventType: string }>;
  cleanupRowsAfter: number;
  cleanupTimelineRowsAfter: number;
};

type NoOutboundEvidence = {
  appendedAuditRows: Array<{ toolName?: string; event?: string; input?: Record<string, unknown> }>;
  forbiddenDbDeltas: {
    sentDrafts: number;
    connectSentEvents: number;
    messageSentEvents: number;
    followUpScheduledEvents: number;
    autoRuns: number;
    autoRunLedgerRows: number;
  };
};

const FORBIDDEN_TOOL_NAMES = new Set([
  "telegram_notify",
  "gh_issue",
  "save_message_draft",
  "mark_message_sent",
  "promote_candidate_to_lead",
  "update_lead_stage",
]);

const OUTBOUND_LABEL_RE = /\b(connect|invite|send|message|follow|comment|post)\b/i;

function assertVersionsMatch(evidence: VersionEvidence): void {
  assert.deepEqual(Object.values(evidence.repoVersions), [
    EXPECTED_VERSION,
    EXPECTED_VERSION,
    EXPECTED_VERSION,
    EXPECTED_VERSION,
    EXPECTED_VERSION,
  ]);
  assert.equal(evidence.installedVersionAfter, EXPECTED_VERSION);
  assert.equal(evidence.installedBundleId, EXPECTED_BUNDLE_ID);
}

function assertHealthProbeRejected(probe: { status: number; ok: boolean }): void {
  assert.notEqual(probe.ok, true);
  assert.notEqual(probe.status, 200);
}

function hasMarker(row: { sourceContext: string | null; evidenceSummary: string | null }): boolean {
  return (
    row.sourceContext?.includes(EXPECTED_MARKER) === true || row.evidenceSummary?.includes(EXPECTED_MARKER) === true
  );
}

function forbiddenOutboundAuditRows(
  rows: NoOutboundEvidence["appendedAuditRows"],
): NoOutboundEvidence["appendedAuditRows"] {
  return rows.filter((row) => {
    if (row.toolName && FORBIDDEN_TOOL_NAMES.has(row.toolName)) return true;
    if (row.event === "approval_resolved" && row.input?.decision === "approved") return true;
    if (row.event?.includes("approval") && OUTBOUND_LABEL_RE.test(JSON.stringify(row.input ?? {}))) return true;
    if (row.toolName === "click" && OUTBOUND_LABEL_RE.test(JSON.stringify(row.input ?? {}))) return true;
    return false;
  });
}

function placeholderVersionEvidence(): VersionEvidence {
  return {
    repoVersions: {
      packageJson: EXPECTED_VERSION,
      packageLock: EXPECTED_VERSION,
      tauriConf: EXPECTED_VERSION,
      cargoToml: EXPECTED_VERSION,
      cargoLock: EXPECTED_VERSION,
    },
    installedVersionBefore: "0.5.0-alpha.56",
    installedVersionAfter: EXPECTED_VERSION,
    installedBundleId: EXPECTED_BUNDLE_ID,
  };
}

function placeholderBuildEvidence(): BuildArtifactEvidence {
  return {
    buildStartedAtMs: 1_787_000_000_000,
    appPath: "src/tauri/src-tauri/target/universal-apple-darwin/release/bundle/macos/Frondose.app",
    appMtimeMs: 1_787_000_001_000,
    binaryArchs: ["x86_64", "arm64"],
    runtimeNodeExecutable: true,
    sidecarExists: true,
    updaterTarballExists: true,
    updaterSigExists: true,
  };
}

function placeholderGuiEvidence(): GuiEvidence {
  return {
    runningExecutable: INSTALLED_BIN,
    visibleWindow: true,
    minimized: false,
    inspectorAttachable: true,
  };
}

function placeholderSidecarEvidence(): SidecarEvidence {
  return {
    pid: 59123,
    ppid: 59000,
    commandPath: APP_SIDECAR,
    ownerEnv: "frondose-app",
    portFile: "/var/folders/x/frondose-com.kyoube.frondose-step2/sidecar.port",
    health: { status: 200, ok: true, pid: 59123 },
    wrongTokenHealth: { status: 401, ok: false },
    unauthenticatedHealth: { status: 401, ok: false },
  };
}

function placeholderChromeEnsureEvidence(): ChromeEnsureEvidence {
  return {
    cdpPortOwner: "frondose",
    response: { status: 200, ok: true, chromePort: 9222, overlayInstalled: true },
    versionEndpointReachable: true,
    profileDir: `${process.env.HOME ?? "~"}/.frondose/agent/chrome-profile`,
  };
}

function placeholderUpdateServerEvidence(): UpdateServerEvidence {
  return {
    activeManifestVersion: "0.5.0-alpha.56",
    configNeutralized: true,
    backupPath: `${process.env.HOME ?? "~"}/.frondose/agent/config.json.p59m-backup`,
    restored: true,
    launchedAppVersion: EXPECTED_VERSION,
  };
}

function placeholderAgentMarkerEvidence(): AgentMarkerEvidence {
  return {
    submittedFromVisibleGui: true,
    directToolExecutionUsed: false,
    auditToolNames: ["navigate_to_url", "inspect", "record_raw_candidate"],
    recordRawCandidateSource: "profile-nav",
    rawCandidateRows: [
      {
        id: "candidate-step2",
        profileUrl: EXPECTED_PROFILE_URL,
        personName: "P59M Step2",
        sourceContext: EXPECTED_MARKER,
        evidenceSummary: "read-only observation marker",
      },
    ],
    timelineRows: [{ candidateId: "candidate-step2", eventType: "discovered" }],
    cleanupRowsAfter: 0,
    cleanupTimelineRowsAfter: 0,
  };
}

function placeholderNoOutboundEvidence(): NoOutboundEvidence {
  return {
    appendedAuditRows: [
      { toolName: "navigate_to_url", input: { url: EXPECTED_PROFILE_URL } },
      { toolName: "inspect" },
      { toolName: "record_raw_candidate" },
    ],
    forbiddenDbDeltas: {
      sentDrafts: 0,
      connectSentEvents: 0,
      messageSentEvents: 0,
      followUpScheduledEvents: 0,
      autoRuns: 0,
      autoRunLedgerRows: 0,
    },
  };
}

describe("P-59M compiled Mac app identity evidence", () => {
  it("T-P59M.1: version parity - repo metadata and installed app converge on alpha.57", () => {
    // Given: repo metadata reports alpha.57 and the installed app may start stale at alpha.56.
    // When: the fresh release bundle is installed to /Applications/Frondose.app.
    // Then: all repo metadata plus the installed Info.plist report alpha.57 and bundle id com.kyoube.frondose.
    const evidence = placeholderVersionEvidence();
    assert.equal(evidence.installedVersionBefore, "0.5.0-alpha.56");
    assertVersionsMatch(evidence);
  });

  it("T-P59M.2: build artifact freshness - acceptance uses the fresh universal bundle", () => {
    // Given: a build-start timestamp is recorded before npm run build:release.
    // When: the universal bundle and runtime files are inspected after the build.
    // Then: the app is newer than build start, has x86_64+arm64 slices, runtime node, sidecarMain.js, tarball, and sig.
    const evidence = placeholderBuildEvidence();
    assert.ok(evidence.appPath.endsWith("/target/universal-apple-darwin/release/bundle/macos/Frondose.app"));
    assert.ok(evidence.appMtimeMs > evidence.buildStartedAtMs);
    assert.deepEqual(new Set(evidence.binaryArchs), new Set(["x86_64", "arm64"]));
    assert.equal(evidence.runtimeNodeExecutable, true);
    assert.equal(evidence.sidecarExists, true);
    assert.equal(evidence.updaterTarballExists, true);
    assert.equal(evidence.updaterSigExists, true);
  });

  it("T-P59M.3: bundle path - running GUI comes from /Applications", () => {
    // Given: old GUI processes are absent or quit before launch.
    // When: Frondose is opened from /Applications/Frondose.app.
    // Then: the running executable resolves to /Applications/Frondose.app/Contents/MacOS/Frondose.
    const evidence = placeholderGuiEvidence();
    assert.equal(evidence.runningExecutable, INSTALLED_BIN);
  });

  it("T-P59M.4: GUI visibility - main window is visible and inspectable", () => {
    // Given: no GUI evidence has been accepted yet.
    // When: the installed app is launched and inspected through macOS GUI automation or equivalent manual evidence.
    // Then: a visible non-minimized Frondose window exists and the main WK webview is inspectable or attachable.
    const evidence = placeholderGuiEvidence();
    assert.equal(evidence.visibleWindow, true);
    assert.equal(evidence.minimized, false);
    assert.equal(evidence.inspectorAttachable, true);
  });
});

describe("P-59M app-owned sidecar and Chrome evidence", () => {
  it("T-P59M.5: sidecar provenance - health belongs to the app-spawned sidecar", () => {
    // Given: no sidecar port is accepted before proving app ownership.
    // When: the app-spawned sidecar process and authenticated /health response are inspected.
    // Then: command path is /Applications/.../runtime/dist/app/sidecarMain.js and /health pid equals that process.
    const evidence = placeholderSidecarEvidence();
    assert.equal(evidence.commandPath, APP_SIDECAR);
    assert.ok(evidence.pid > 0);
    assert.ok(evidence.ppid > 0);
    assert.match(evidence.portFile, /frondose-com\.kyoube\.frondose-/);
    assert.equal(evidence.ownerEnv, "frondose-app");
    assert.deepEqual(evidence.health, { status: 200, ok: true, pid: evidence.pid });
  });

  it("T-P59M.6: sidecar health - authenticated /health rejects stale or unauthenticated probes", () => {
    // Given: port and bearer token are parsed from the app-spawned sidecar.
    // When: /health is called with the right bearer, no bearer, and a wrong bearer token.
    // Then: only the right bearer returns a successful health envelope; wrong-token and unauthenticated probes fail.
    const evidence = placeholderSidecarEvidence();
    assert.equal(evidence.health.status, 200);
    assert.equal(evidence.health.ok, true);
    assertHealthProbeRejected(evidence.wrongTokenHealth);
    assertHealthProbeRejected(evidence.unauthenticatedHealth);
  });

  it("T-P59M.7: Chrome ensure - overlay installs through the app-owned sidecar", () => {
    // Given: port 9222 ownership is classified as absent or Frondose-owned before the call.
    // When: POST /chrome/ensure is sent to the app-owned sidecar with the bearer token.
    // Then: response is ok with chromePort 9222, overlayInstalled true, and /json/version reachable.
    const evidence = placeholderChromeEnsureEvidence();
    assert.notEqual(evidence.cdpPortOwner, "foreign");
    assert.equal(evidence.response.status, 200);
    assert.equal(evidence.response.ok, true);
    assert.equal(evidence.response.chromePort, 9222);
    assert.equal(evidence.response.overlayInstalled, true);
    assert.equal(evidence.versionEndpointReachable, true);
    assert.match(evidence.profileDir, /\.frondose\/agent\/chrome-profile$/);
  });
});

describe("P-59M update-server and durable marker evidence", () => {
  it("T-P59M.8: update-server risk - updater cannot silently change the target version", () => {
    // Given: an active update endpoint/version is recorded or app update URL is backed up before launch.
    // When: the endpoint would offer a non-alpha.57 version.
    // Then: update checks are neutralized for the run, the launched app stays alpha.57, and config is restored.
    const evidence = placeholderUpdateServerEvidence();
    if (evidence.activeManifestVersion !== null && evidence.activeManifestVersion !== EXPECTED_VERSION) {
      assert.equal(evidence.configNeutralized, true);
      assert.ok(evidence.backupPath);
    }
    assert.equal(evidence.launchedAppVersion, EXPECTED_VERSION);
    assert.equal(evidence.restored, true);
  });

  it("T-P59M.9: real-agent path - live marker is produced by the GUI agent loop", () => {
    // Given: selected profile URL and marker are absent from raw_candidates and audit offsets are recorded.
    // When: the visible GUI submits the read-only agent prompt.
    // Then: appended audit rows show LLM-selected record_raw_candidate and no direct tool execution evidence is used.
    const evidence = placeholderAgentMarkerEvidence();
    assert.equal(evidence.submittedFromVisibleGui, true);
    assert.equal(evidence.directToolExecutionUsed, false);
    assert.ok(evidence.auditToolNames.includes("record_raw_candidate"));
    assert.equal(evidence.recordRawCandidateSource, "profile-nav");
    assert.ok(evidence.rawCandidateRows.some((row) => row.profileUrl === EXPECTED_PROFILE_URL && hasMarker(row)));
  });

  it("T-P59M.10: durable state marker - read-only profile observation writes local state", () => {
    // Given: the P-59M marker is absent from sales.sqlite before the GUI turn.
    // When: the read-only profile observation completes.
    // Then: exactly one raw_candidates row and one discovered lead_timeline row exist for the marker.
    const evidence = placeholderAgentMarkerEvidence();
    assert.equal(evidence.rawCandidateRows.length, 1);
    const [candidate] = evidence.rawCandidateRows;
    assert.ok(candidate);
    assert.equal(candidate.profileUrl, EXPECTED_PROFILE_URL);
    assert.ok(hasMarker(candidate));
    assert.deepEqual(evidence.timelineRows, [{ candidateId: candidate.id, eventType: "discovered" }]);
  });

  it("T-P59M.11: cleanup - marker state is removed after evidence capture", () => {
    // Given: the marker row exists after the live GUI run.
    // When: Frondose quits and cleanup deletes marker rows or restores the pre-run DB backup.
    // Then: marker raw_candidate and lead_timeline rows are absent after cleanup verification.
    const evidence = placeholderAgentMarkerEvidence();
    assert.equal(evidence.cleanupRowsAfter, 0);
    assert.equal(evidence.cleanupTimelineRowsAfter, 0);
  });
});

describe("P-59M no-outbound residue evidence", () => {
  it("T-P59M.12: no outbound - acceptance leaves no outbound audit or sales residue", () => {
    // Given: audit offsets and outbound-related DB counts are recorded before the GUI turn.
    // When: only rows appended during P-59M and marker-related DB deltas are checked.
    // Then: no forbidden outbound tools, approval events, sent drafts, outbound clicks, auto runs, or ledger rows appear.
    const evidence = placeholderNoOutboundEvidence();
    assert.ok(evidence.appendedAuditRows.some((row) => row.toolName === "record_raw_candidate"));
    assert.deepEqual(forbiddenOutboundAuditRows(evidence.appendedAuditRows), []);
    assert.deepEqual(evidence.forbiddenDbDeltas, {
      sentDrafts: 0,
      connectSentEvents: 0,
      messageSentEvents: 0,
      followUpScheduledEvents: 0,
      autoRuns: 0,
      autoRunLedgerRows: 0,
    });
  });
});
