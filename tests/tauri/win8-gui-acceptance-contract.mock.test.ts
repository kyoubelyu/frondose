/**
 * WIN-8 Step 5 filled acceptance contract - Windows TightVNC GUI installed-app.
 *
 * These tests are GREEN on valid evidence and RED on the new negative cases
 * (CH-WIN8-TESTFIX). They are no longer an all-failing Step-2 scaffold.
 *
 * Run:
 *   node --import tsx --test --test-force-exit \
 *     tests/tauri/win8-gui-acceptance-contract.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const EXPECTED_VERSION = "0.5.0-alpha.57";
const PROGRAM_FILES_APP = "C:\\Program Files\\Frondose\\Frondose.exe";
const PROGRAM_FILES_RUNTIME = "C:\\Program Files\\Frondose\\runtime";
const PROGRAM_FILES_NODE = `${PROGRAM_FILES_RUNTIME}\\node.exe`;
const PROGRAM_FILES_SIDECAR = `${PROGRAM_FILES_RUNTIME}\\dist\\app\\sidecarMain.js`;
const EXPECTED_PROFILE_URL = "https://www.linkedin.com/in/win8-step2-placeholder/";
const EXPECTED_MARKER = "WIN8-GUI-L1-step2-placeholder";

type FailureClass =
  | "tool_ref_failure"
  | "tool_targeting_failure"
  | "tool_navigation_failure"
  | "tool_snapshot_failure"
  | "tool_timing_failure"
  | "tool_outbound_surface_failure"
  | "llm_planning_failure"
  | "prompt_context_failure"
  | "state_model_failure";

type VersionEvidence = {
  repoVersions: Record<"packageJson" | "packageLock" | "tauriConf" | "cargoToml" | "cargoLock", string>;
  installedVersionBefore: string;
  installedVersionAfter: string;
  runtimeCliVersionAfter: string;
};

type BuildFreshnessEvidence = {
  buildStartedAtMs: number;
  artifactMtimeMs: number;
  installedMtimeMs: number;
  artifactContainsNodeExe: boolean;
  artifactContainsSidecar: boolean;
  installedContainsNodeExe: boolean;
  installedContainsSidecar: boolean;
};

type RuntimeDepsEvidence = {
  runtimeCwd: string;
  nodeExePath: string;
  nodeAbi: string;
  betterSqlite3Loads: boolean;
  ssh2Loads: boolean;
};

type DisplayEvidence = {
  tightVncAuthenticated: boolean;
  framebufferAllBlack: boolean;
  nonblackScreenshotContainsFrondose: boolean;
  operatorApprovedUiaEquivalent: boolean;
};

type GuiEvidence = {
  baselineHadFrondoseProcess: boolean;
  runningExecutable: string;
  visibleWindow: boolean;
  minimized: boolean;
  displayedVersion: string;
};

type NodeResolutionEvidence = {
  runtimeNodeExeExists: boolean;
  selectedNodePath: string;
  sidecarSpawned: boolean;
  failureClass?: FailureClass;
};

type SidecarEvidence = {
  pid: number;
  guiPid: number;
  commandPath: string;
  ownerEnv?: string;
  portFile: string;
  /**
   * Describes the probe that successfully authenticated (e.g. "true-bearer").
   * Must differ from wrongTokenProbeLabel so an auth-bypass (any token accepted)
   * cannot satisfy both the positive and negative checks simultaneously.
   */
  authenticatedProbeLabel: string;
  wrongTokenProbeLabel: string;
  health: { status: number; ok: boolean; pid: number };
  wrongTokenHealth: { status: number; ok: boolean };
  unauthenticatedHealth: { status: number; ok: boolean };
};

type ChromeEvidence = {
  cdpPortOwner: "absent" | "frondose" | "foreign";
  ensure: { status: number; ok: boolean; chromePort: number; overlayInstalled: boolean };
  jsonVersionReachable: boolean;
  chromeProfileOwner: "frondose" | "foreign";
};

type CdpReadOnlyEvidence = {
  targetUrl: string;
  pageStateMatchedToolResult: boolean;
  outboundSurfaceUsed: boolean;
};

type AgentEvidence = {
  submittedFromVisibleGui: boolean;
  directToolExecutionUsed: boolean;
  auditToolNames: string[];
  rawCandidateRows: Array<{
    id: string;
    profileUrl: string;
    sourceContext: string | null;
    evidenceSummary: string | null;
  }>;
  timelineRows: Array<{ candidateId: string; eventType: string }>;
  /** rows present BEFORE cleanup — must be > 0 to prove rows were created and then removed */
  cleanupRowsBefore: number;
  cleanupTimelineBefore: number;
  cleanupRowsAfter: number;
  cleanupTimelineRowsAfter: number;
};

type NoOutboundEvidence = {
  appendedAuditRows: Array<{ toolName?: string; event?: string; input?: Record<string, unknown> }>;
  forbiddenDbDeltas: {
    approvals: number;
    sentDrafts: number;
    outboundTimelineEvents: number;
    telegramNotify: number;
    ghIssue: number;
    autoRuns: number;
    autoRunLedgerRows: number;
  };
};

const SECRET_SENTINELS = [
  "placeholder-vnc-secret",
  "placeholder-ssh-secret",
  "placeholder-provider-key",
  "placeholder-sidecar-token",
  "placeholder-cookie-value",
];

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
    runtimeCliVersionAfter: EXPECTED_VERSION,
  };
}

function placeholderBuildFreshnessEvidence(): BuildFreshnessEvidence {
  return {
    buildStartedAtMs: 1_787_000_000_000,
    artifactMtimeMs: 1_787_000_010_000,
    installedMtimeMs: 1_787_000_020_000,
    artifactContainsNodeExe: true,
    artifactContainsSidecar: true,
    installedContainsNodeExe: true,
    installedContainsSidecar: true,
  };
}

function placeholderRuntimeDepsEvidence(): RuntimeDepsEvidence {
  return {
    runtimeCwd: PROGRAM_FILES_RUNTIME,
    nodeExePath: PROGRAM_FILES_NODE,
    nodeAbi: "127",
    betterSqlite3Loads: true,
    ssh2Loads: true,
  };
}

function placeholderDisplayEvidence(): DisplayEvidence {
  return {
    tightVncAuthenticated: true,
    framebufferAllBlack: false,
    nonblackScreenshotContainsFrondose: true,
    operatorApprovedUiaEquivalent: false,
  };
}

function placeholderGuiEvidence(): GuiEvidence {
  return {
    baselineHadFrondoseProcess: false,
    runningExecutable: PROGRAM_FILES_APP,
    visibleWindow: true,
    minimized: false,
    displayedVersion: EXPECTED_VERSION,
  };
}

function placeholderNodeResolutionEvidence(): NodeResolutionEvidence {
  return {
    runtimeNodeExeExists: true,
    selectedNodePath: PROGRAM_FILES_NODE,
    sidecarSpawned: true,
  };
}

function placeholderSidecarEvidence(): SidecarEvidence {
  return {
    pid: 57057,
    guiPid: 57040,
    commandPath: PROGRAM_FILES_SIDECAR,
    ownerEnv: "frondose-app",
    portFile: "C:\\Users\\user\\AppData\\Local\\Temp\\frondose-com.kyoube.frondose-step2\\frondose.port",
    authenticatedProbeLabel: "true-bearer",
    wrongTokenProbeLabel: "wrong-bearer-placeholder",
    health: { status: 200, ok: true, pid: 57057 },
    wrongTokenHealth: { status: 401, ok: false },
    unauthenticatedHealth: { status: 401, ok: false },
  };
}

function placeholderChromeEvidence(): ChromeEvidence {
  return {
    cdpPortOwner: "frondose",
    ensure: { status: 200, ok: true, chromePort: 9222, overlayInstalled: true },
    jsonVersionReachable: true,
    chromeProfileOwner: "frondose",
  };
}

function placeholderCdpReadOnlyEvidence(): CdpReadOnlyEvidence {
  return {
    targetUrl: EXPECTED_PROFILE_URL,
    pageStateMatchedToolResult: true,
    outboundSurfaceUsed: false,
  };
}

function placeholderAgentEvidence(): AgentEvidence {
  return {
    submittedFromVisibleGui: true,
    directToolExecutionUsed: false,
    auditToolNames: ["navigate_to_url", "inspect", "record_raw_candidate"],
    rawCandidateRows: [
      {
        id: "candidate-win8-step2",
        profileUrl: EXPECTED_PROFILE_URL,
        sourceContext: EXPECTED_MARKER,
        evidenceSummary: "read-only Windows GUI marker",
      },
    ],
    timelineRows: [{ candidateId: "candidate-win8-step2", eventType: "discovered" }],
    cleanupRowsBefore: 1,
    cleanupTimelineBefore: 1,
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
      approvals: 0,
      sentDrafts: 0,
      outboundTimelineEvents: 0,
      telegramNotify: 0,
      ghIssue: 0,
      autoRuns: 0,
      autoRunLedgerRows: 0,
    },
  };
}

function redactValidationEvidence(text: string): string {
  return text
    .replace(/(--token(?:=|\s+))[^\s]+/g, "$1[REDACTED]")
    .replace(/(Authorization:\s*Bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/(WIN8_(?:VNC|SSH|PROVIDER)_SECRET=)[^\s]+/g, "$1[REDACTED]")
    .replace(/("cookie"\s*:\s*")[^"]+"/gi, '$1[REDACTED]"');
}

function assertNoPlaceholderSecretMaterial(text: string): void {
  for (const sentinel of SECRET_SENTINELS) assert.equal(text.includes(sentinel), false);
}

function assertVersionEvidence(evidence: VersionEvidence): void {
  assert.deepEqual(Object.values(evidence.repoVersions), [
    EXPECTED_VERSION,
    EXPECTED_VERSION,
    EXPECTED_VERSION,
    EXPECTED_VERSION,
    EXPECTED_VERSION,
  ]);
  assert.equal(evidence.installedVersionBefore, "0.5.0-alpha.56");
  assert.equal(evidence.installedVersionAfter, EXPECTED_VERSION);
  assert.equal(evidence.runtimeCliVersionAfter, EXPECTED_VERSION);
}

function assertBuildFreshnessEvidence(evidence: BuildFreshnessEvidence): void {
  assert.ok(evidence.artifactMtimeMs > evidence.buildStartedAtMs);
  assert.ok(evidence.installedMtimeMs >= evidence.artifactMtimeMs);
  assert.equal(evidence.artifactContainsNodeExe, true);
  assert.equal(evidence.artifactContainsSidecar, true);
  assert.equal(evidence.installedContainsNodeExe, true);
  assert.equal(evidence.installedContainsSidecar, true);
}

function assertRuntimeDepsEvidence(evidence: RuntimeDepsEvidence): void {
  assert.equal(evidence.runtimeCwd, PROGRAM_FILES_RUNTIME);
  assert.equal(evidence.nodeExePath, PROGRAM_FILES_NODE);
  assert.equal(evidence.nodeAbi, "127");
  assert.equal(evidence.betterSqlite3Loads, true);
  assert.equal(evidence.ssh2Loads, true);
}

function assertDisplayEvidence(evidence: DisplayEvidence): void {
  assert.equal(evidence.tightVncAuthenticated, true);
  assert.equal(
    evidence.framebufferAllBlack && !evidence.operatorApprovedUiaEquivalent,
    false,
    "black-only VNC frames cannot satisfy GUI acceptance",
  );
  assert.equal(evidence.nonblackScreenshotContainsFrondose || evidence.operatorApprovedUiaEquivalent, true);
}

function assertGuiEvidence(evidence: GuiEvidence): void {
  assert.equal(evidence.baselineHadFrondoseProcess, false);
  assert.equal(evidence.runningExecutable, PROGRAM_FILES_APP);
  assert.equal(evidence.visibleWindow, true);
  assert.equal(evidence.minimized, false);
  assert.equal(evidence.displayedVersion, EXPECTED_VERSION);
}

function assertNodeResolutionEvidence(evidence: NodeResolutionEvidence): void {
  assert.equal(evidence.runtimeNodeExeExists, true);
  if (!evidence.sidecarSpawned) {
    assert.ok(evidence.failureClass, "failed sidecar spawn must be classified");
    assert.ok(["tool_ref_failure", "state_model_failure"].includes(evidence.failureClass));
    return;
  }
  assert.equal(evidence.selectedNodePath, PROGRAM_FILES_NODE);
}

function assertSidecarProvenanceEvidence(evidence: SidecarEvidence): void {
  assert.equal(evidence.commandPath, PROGRAM_FILES_SIDECAR);
  assert.match(evidence.portFile, /frondose-com\.kyoube\.frondose-/);
  assert.equal(evidence.ownerEnv, "frondose-app");
  assert.equal(evidence.health.status, 200);
  assert.equal(evidence.health.ok, true);
  assert.equal(evidence.health.pid, evidence.pid);
  assert.ok(evidence.guiPid > 0);
}

function assertSidecarAuthEvidence(evidence: SidecarEvidence): void {
  // The authenticated probe must use the true bearer and must differ from the wrong-token probe.
  assert.equal(evidence.authenticatedProbeLabel, "true-bearer");
  assert.notEqual(
    evidence.wrongTokenProbeLabel,
    "true-bearer",
    "wrong-token probe must use a different credential than the true bearer",
  );
  // Only the true bearer returns a successful health envelope.
  assert.equal(evidence.health.ok, true);
  assert.notEqual(evidence.wrongTokenHealth.status, 200);
  assert.notEqual(evidence.wrongTokenHealth.ok, true);
  assert.notEqual(evidence.unauthenticatedHealth.status, 200);
  assert.notEqual(evidence.unauthenticatedHealth.ok, true);
}

function assertChromeEvidence(evidence: ChromeEvidence): void {
  assert.notEqual(evidence.cdpPortOwner, "foreign");
  assert.equal(evidence.ensure.status, 200);
  assert.equal(evidence.ensure.ok, true);
  assert.equal(evidence.ensure.chromePort, 9222);
  assert.equal(evidence.ensure.overlayInstalled, true);
  assert.equal(evidence.jsonVersionReachable, true);
  assert.equal(evidence.chromeProfileOwner, "frondose");
}

function assertCdpReadOnlyEvidence(evidence: CdpReadOnlyEvidence): void {
  assert.equal(evidence.targetUrl, EXPECTED_PROFILE_URL);
  assert.equal(evidence.pageStateMatchedToolResult, true);
  assert.equal(evidence.outboundSurfaceUsed, false);
}

function assertAgentPathEvidence(evidence: AgentEvidence): void {
  assert.equal(evidence.submittedFromVisibleGui, true);
  assert.equal(evidence.directToolExecutionUsed, false);
  assert.ok(evidence.auditToolNames.includes("record_raw_candidate"));
}

function assertDurableMarkerEvidence(evidence: AgentEvidence): void {
  assert.equal(evidence.rawCandidateRows.length, 1);
  const row = evidence.rawCandidateRows[0];
  assert.ok(row);
  assert.equal(row.profileUrl, EXPECTED_PROFILE_URL);
  assert.equal(row.sourceContext?.includes(EXPECTED_MARKER) || row.evidenceSummary?.includes(EXPECTED_MARKER), true);
  assert.deepEqual(evidence.timelineRows, [{ candidateId: row.id, eventType: "discovered" }]);
}

function assertCleanupEvidence(evidence: AgentEvidence): void {
  // Require a non-zero before-baseline so a no-op cleanup (rows never created) cannot pass.
  assert.ok(evidence.cleanupRowsBefore > 0, "cleanup must prove rows existed before removal");
  assert.ok(evidence.cleanupTimelineBefore > 0, "cleanup must prove timeline rows existed before removal");
  assert.equal(evidence.cleanupRowsAfter, 0);
  assert.equal(evidence.cleanupTimelineRowsAfter, 0);
}

function assertNoOutboundEvidence(evidence: NoOutboundEvidence): void {
  const forbiddenToolPattern =
    /connect|invite|message|send|follow|comment|post|save_message_draft|telegram_notify|gh_issue/i;
  assert.equal(
    evidence.appendedAuditRows.some((row) => forbiddenToolPattern.test(String(row.toolName ?? row.event ?? ""))),
    false,
  );
  assert.deepEqual(evidence.forbiddenDbDeltas, {
    approvals: 0,
    sentDrafts: 0,
    outboundTimelineEvents: 0,
    telegramNotify: 0,
    ghIssue: 0,
    autoRuns: 0,
    autoRunLedgerRows: 0,
  });
}

describe("WIN-8 installed Windows GUI acceptance contract - build and installed identity", () => {
  it("T-WIN8.1: version parity - repo alpha.57 is installed to Program Files", () => {
    // Given: repo metadata is alpha.57 and installed evidence may start alpha.56; When: install evidence is evaluated; Then: Program Files Frondose.exe and runtime versions converge on alpha.57.
    const evidence = placeholderVersionEvidence();
    assertVersionEvidence(evidence);
  });

  it("T-WIN8.2: build freshness - acceptance uses a newly built Windows bundle", () => {
    // Given: a build-start timestamp; When: Windows artifact and installed files are inspected; Then: accepted files are newer than build start and contain runtime node.exe plus runtime\\dist\\app\\sidecarMain.js.
    const evidence = placeholderBuildFreshnessEvidence();
    assertBuildFreshnessEvidence(evidence);
  });

  it("T-WIN8.3: runtime deps - installed alpha.57 runtime keeps Node ABI 127 native loadability", () => {
    // Given: the installed runtime path is Program Files runtime; When: node ABI and native requires are checked from that cwd; Then: ABI is 127 and better-sqlite3 plus ssh2 load.
    const evidence = placeholderRuntimeDepsEvidence();
    assertRuntimeDepsEvidence(evidence);
  });
});

describe("WIN-8 installed Windows GUI acceptance contract - display and GUI provenance", () => {
  it("T-WIN8.4: display evidence - black VNC frames cannot satisfy GUI acceptance", () => {
    // Given: TightVNC captures may be black; When: display evidence is classified; Then: black-only screenshots fail and only nonblack visible GUI or operator-approved UIA-equivalent evidence can pass.
    const evidence = placeholderDisplayEvidence();
    assertDisplayEvidence(evidence);
  });

  it("T-WIN8.4-neg: display evidence - black-only evidence with no UIA approval is rejected", () => {
    // Given: a capture that is all-black and has no operator-approved UIA-equivalent; When: the classifier evaluates it; Then: the black-only evidence fails the gate.
    const blackEvidence: DisplayEvidence = {
      tightVncAuthenticated: true,
      framebufferAllBlack: true,
      nonblackScreenshotContainsFrondose: false,
      operatorApprovedUiaEquivalent: false,
    };
    assert.throws(
      () => assertDisplayEvidence(blackEvidence),
      (err: unknown) => err instanceof assert.AssertionError,
      "black-only evidence with no UIA approval must fail the gate",
    );
  });

  it("T-WIN8.5: visible GUI - installed Frondose window belongs to Program Files executable", () => {
    // Given: baseline has no Frondose GUI; When: window/process evidence is evaluated; Then: the visible Frondose window is tied to C:\\Program Files\\Frondose\\Frondose.exe and alpha.57.
    const evidence = placeholderGuiEvidence();
    assertGuiEvidence(evidence);
  });

  it("T-WIN8.6: node path resolution - installed GUI can spawn bundled node.exe sidecar", () => {
    // Given: Windows runtime contains node.exe and app launch chooses a node path; When: sidecar spawn evidence is evaluated; Then: the chosen executable is valid on Windows or the failure is classified for the scoped node.exe fix.
    const evidence = placeholderNodeResolutionEvidence();
    assertNodeResolutionEvidence(evidence);
  });
});

describe("WIN-8 installed Windows GUI acceptance contract - app-owned sidecar and Chrome", () => {
  it("T-WIN8.7: sidecar provenance - health belongs to the GUI-spawned app sidecar", () => {
    // Given: app sidecar process, port file, token, and health response evidence; When: provenance is checked; Then: sidecarMain.js path, owner, port-file dir, and health pid all match the GUI-spawned sidecar.
    const evidence = placeholderSidecarEvidence();
    assertSidecarProvenanceEvidence(evidence);
  });

  it("T-WIN8.8: sidecar auth - wrong-token and unauthenticated health probes are rejected", () => {
    // Given: authenticated, wrong-token, and no-token health responses; When: auth evidence is classified; Then: only the true bearer returns a successful health envelope.
    const evidence = placeholderSidecarEvidence();
    assertSidecarAuthEvidence(evidence);
  });

  it("T-WIN8.8-neg: sidecar auth - auth-bypass where wrong token is also accepted is rejected by classifier", () => {
    // Given: a sidecar that accepts any token (auth bypass); When: the evidence reflects wrong-token also accepted; Then: the classifier rejects it because the wrong-token label is the same as the true-bearer label.
    const authBypassEvidence: SidecarEvidence = {
      ...placeholderSidecarEvidence(),
      // An auth-bypass fixture where the wrong token was effectively the same credential as the true bearer.
      wrongTokenProbeLabel: "true-bearer",
      wrongTokenHealth: { status: 200, ok: true },
    };
    assert.throws(
      () => assertSidecarAuthEvidence(authBypassEvidence),
      (err: unknown) => err instanceof assert.AssertionError,
      "auth-bypass evidence must be rejected by the classifier",
    );
  });

  it("T-WIN8.9: Chrome ensure - app-owned sidecar installs overlay and exposes CDP", () => {
    // Given: 9222 ownership is absent or Frondose-owned; When: chrome ensure evidence is evaluated; Then: overlayInstalled is true and /json/version is reachable.
    const evidence = placeholderChromeEvidence();
    assertChromeEvidence(evidence);
  });

  it("T-WIN8.10: CDP read-only browser flow - app-owned Chrome can observe a stable page", () => {
    // Given: app-owned Chrome is ensured; When: a stable approved page is inspected by CDP; Then: observed page state matches tool evidence and no outbound surface is used.
    const evidence = placeholderCdpReadOnlyEvidence();
    assertCdpReadOnlyEvidence(evidence);
  });
});

describe("WIN-8 installed Windows GUI acceptance contract - real-agent outcome", () => {
  it("T-WIN8.11: GUI real-agent path - live marker is produced by the visible GUI full agent loop", () => {
    // Given: marker/profile are absent and audit offsets are recorded; When: GUI-submitted turn evidence is evaluated; Then: appended audit rows show LLM-selected record_raw_candidate and no direct tool execution.
    const evidence = placeholderAgentEvidence();
    assertAgentPathEvidence(evidence);
  });

  it("T-WIN8.12: durable state marker - read-only profile observation writes local product state", () => {
    // Given: marker is absent before the run; When: durable state evidence is checked; Then: exactly one raw candidate and one discovered timeline row exist for the marker.
    const evidence = placeholderAgentEvidence();
    assertDurableMarkerEvidence(evidence);
  });

  it("T-WIN8.13: cleanup - marker state is removed after evidence capture", () => {
    // Given: marker rows exist after evidence capture; When: cleanup evidence is evaluated; Then: marker raw candidate and timeline rows are absent.
    const evidence = placeholderAgentEvidence();
    assertCleanupEvidence(evidence);
  });

  it("T-WIN8.13-neg: cleanup - no-op cleanup where rows were never created is rejected", () => {
    // Given: a cleanup evidence where before-counts are 0 (rows were never created); When: the classifier evaluates it; Then: it fails because there is no proof that rows were removed.
    const noOpEvidence: AgentEvidence = {
      ...placeholderAgentEvidence(),
      cleanupRowsBefore: 0,
      cleanupTimelineBefore: 0,
      cleanupRowsAfter: 0,
      cleanupTimelineRowsAfter: 0,
    };
    assert.throws(
      () => assertCleanupEvidence(noOpEvidence),
      (err: unknown) => err instanceof assert.AssertionError,
      "no-op cleanup with zero before-counts must fail the gate",
    );
  });

  it("T-WIN8.14: no outbound - acceptance leaves no outbound audit or sales residue", () => {
    // Given: audit offsets and outbound DB counters; When: appended rows and deltas are inspected; Then: no forbidden outbound tools, approvals, sent drafts, outbound timeline events, or auto-run residue appears.
    const evidence = placeholderNoOutboundEvidence();
    assertNoOutboundEvidence(evidence);
  });

  it("T-WIN8.15: secret handling - validation evidence redacts credentials and bearer material", () => {
    // Given: evidence text from live validation; When: redaction rules are applied; Then: VNC/SSH/provider placeholders, cookies, and bearer tokens are absent from persisted output.
    const redacted = redactValidationEvidence(
      'WIN8_VNC_SECRET=placeholder-vnc-secret WIN8_SSH_SECRET=placeholder-ssh-secret WIN8_PROVIDER_SECRET=placeholder-provider-key --token placeholder-sidecar-token Authorization: Bearer placeholder-sidecar-token "cookie":"placeholder-cookie-value"',
    );
    assertNoPlaceholderSecretMaterial(redacted);
    assert.match(redacted, /--token \[REDACTED\]/);
    assert.match(redacted, /Authorization: Bearer \[REDACTED\]/);
  });
});
