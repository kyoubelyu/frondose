import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, before, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { CoreMessage, ToolSet } from "ai";
import { composeSoulBand } from "../../src/agent/systemPrompt/soul.js";
import { closeSalesDatabase, openSalesDatabase } from "../../src/persistence/salesDb.js";
import { makeRecordRawCandidateTool } from "../../src/tools/sales/recordRawCandidate.js";

type Family = "causal" | "stakeholder" | "quantity" | "resistance" | "enterprise" | "exploratory";
type Scenario = {
  id: string;
  family: Family;
  evidence: string;
  facts: Record<string, boolean>;
  decision: string;
  state: string;
};
type ScenarioInput = Pick<Scenario, "id" | "evidence" | "facts">;
type RunPi = (opts: {
  model: unknown;
  system: string;
  messages: CoreMessage[];
  tools: ToolSet;
  maxSteps?: number;
  activeTools?: string[];
  onToolCall?: (name: string) => void;
}) => Promise<unknown>;
type ContractModule = {
  inventoryMethodologyCarriers(
    repository: string,
  ): Promise<Array<{ path: string; disposition: string; discoveredBy: string[] }>>;
};

const CONTRACT = join(process.cwd(), "scripts", "public-sales-contract.mjs");
const temporaryDirectories: string[] = [];
let runAgentLoopPi: RunPi | null = null;

const REFERENCE_GENERIC_DOCTRINE = [
  "Establish a plausible cause before proposing a capability; then trace organizational impact and ask for a buyer-owned outcome.",
  "Map affected stakeholders in both directions: upstream decision owners and downstream operational roles.",
  "Use buyer-confirmed quantities when available and never invent numbers.",
  "On resistance, reduce pressure and return to open discovery.",
  "Choose enterprise-mapping for multi-stakeholder evidence.",
  "Choose exploratory discovery for thin evidence.",
].join("\n");

const FAMILY_SUPPORT: Record<Family, (system: string) => boolean> = {
  causal: (system) => /establish[^.]+cause before[^.]+capability/i.test(system),
  stakeholder: (system) =>
    /map affected stakeholders[^.]+upstream decision owners[^.]+downstream operational roles/i.test(system),
  quantity: (system) => /buyer-confirmed quantities[^.]+never invent numbers/i.test(system),
  resistance: (system) => /on resistance[^.]+reduce pressure[^.]+return to open discovery/i.test(system),
  enterprise: (system) => /choose enterprise-mapping for multi-stakeholder evidence/i.test(system),
  exploratory: (system) => /choose exploratory discovery for thin evidence/i.test(system),
};

const FAMILY_MUTATION: Record<Family, (system: string) => string> = {
  causal: (system) =>
    system.replace(
      /Establish a plausible cause before proposing a capability/,
      "Cause and capability remain important words, but propose capability before establishing a cause",
    ),
  stakeholder: (system) =>
    system.replace(
      /Map affected stakeholders in both directions: upstream decision owners and downstream operational roles/,
      "Mention affected stakeholders, upstream decision owners, and downstream operational roles, but map neither direction",
    ),
  quantity: (system) =>
    system.replace(
      /Use buyer-confirmed quantities when available and never invent numbers/,
      "Mention buyer-confirmed quantities, but invent numbers whenever evidence is absent",
    ),
  resistance: (system) =>
    system.replace(
      /On resistance, reduce pressure and return to open discovery/,
      "On resistance, mention pressure and open discovery but increase pressure with confirming questions",
    ),
  enterprise: (system) =>
    system.replace(
      /Choose enterprise-mapping for multi-stakeholder evidence/,
      "Mention enterprise-mapping and multi-stakeholder evidence but choose a single-contact shortcut",
    ),
  exploratory: (system) =>
    system.replace(
      /Choose exploratory discovery for thin evidence/,
      "Mention exploratory discovery and thin evidence but qualify immediately",
    ),
};

const FACTS: Record<Family, Record<string, boolean>> = {
  causal: { symptomWithoutCause: true },
  stakeholder: { crossFunctionalImpact: true },
  quantity: { buyerSuppliedQuantity: true },
  resistance: { buyerResistance: true },
  enterprise: { multiStakeholderDecision: true },
  exploratory: { thinEvidence: true },
};

const EVIDENCE: Record<Family, string[]> = {
  causal: [
    "Onboarding is slow but the cause is unknown.",
    "Forecast quality dropped; no mechanism is established.",
    "Cycle time rose after a handoff change.",
    "The buyer names a symptom but no desired capability.",
  ],
  stakeholder: [
    "Operations rework reaches finance.",
    "Support backlog affects customer success and renewals.",
    "Engineering delay changes sales commitments.",
    "Security review blocks an executive launch date.",
  ],
  quantity: [
    "The buyer confirms 12 hours per week.",
    "Finance validates a 9 percent leakage figure.",
    "The operator supplies a 14-day baseline.",
    "No numeric value exists beyond a buyer-owned range.",
  ],
  resistance: [
    "Not interested; too many questions.",
    "The buyer gives a short reply and changes topic.",
    "A confirming question produces visible discomfort.",
    "The prospect asks to slow the conversation down.",
  ],
  enterprise: [
    "Security, finance, operations and an executive sponsor are involved.",
    "Procurement and three operational groups share the decision.",
    "A multi-region committee owns the outcome.",
    "Technical and economic buyers disagree on success.",
  ],
  exploratory: [
    "Only a role and one vague symptom are visible.",
    "A first reply has no quantified impact.",
    "The profile suggests fit but supplies no causal evidence.",
    "One weak signal exists and no stakeholder map is known.",
  ],
};

const SCENARIOS: Scenario[] = (Object.keys(EVIDENCE) as Family[]).flatMap((family) =>
  EVIDENCE[family].map((evidence, index) => ({
    id: `${family}-${index + 1}`,
    family,
    evidence,
    facts: FACTS[family],
    decision: `decision:${family}`,
    state: `method:${family}`,
  })),
);
const SCENARIO_CORPUS_SHA256 = "03273dcfd2fef42c961daf65c95f10272f4915fba3e52c70dba0aea93dd440e6";

function assistantMessage(
  stopReason: AssistantMessage["stopReason"],
  content: AssistantMessage["content"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "deepseek",
    model: "public-doctrine-test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function streamResult(message: AssistantMessage) {
  return {
    [Symbol.asyncIterator]: () =>
      (async function* () {
        yield { type: "start", partial: assistantMessage("stop", []) };
        yield { type: "done", reason: message.stopReason, message };
      })(),
    result: async () => message,
  };
}

function scenarioFromMessages(messages: Array<{ role: string; content: unknown }>): ScenarioInput {
  const user = messages.find(
    (message) => message.role === "user" && typeof message.content === "string" && message.content.startsWith("{"),
  );
  assert.ok(user && typeof user.content === "string", "scenario user message is present");
  return JSON.parse(user.content) as ScenarioInput;
}

function classifyEvidence(input: ScenarioInput): Family {
  const matches = (Object.entries(FACTS) as Array<[Family, Record<string, boolean>]>).filter(([, facts]) =>
    Object.keys(facts).every((key) => input.facts[key] === true),
  );
  assert.equal(matches.length, 1, `${input.id}: evidence must select exactly one behavior family`);
  return matches[0]?.[0] as Family;
}

before(async () => {
  const piAiUrl = import.meta.resolve("@earendil-works/pi-ai");
  mock.module(piAiUrl, {
    namedExports: {
      stream: (
        _model: unknown,
        context: { systemPrompt: string; messages: Array<{ role: string; content: unknown }> },
      ) => {
        const scenario = scenarioFromMessages(context.messages);
        const family = classifyEvidence(scenario);
        const decision = `decision:${family}`;
        const state = `method:${family}`;
        const alreadyRecorded = context.messages.some((message) => message.role === "toolResult");
        if (alreadyRecorded) return streamResult(assistantMessage("stop", [{ type: "text", text: decision }]));
        if (!FAMILY_SUPPORT[family](context.systemPrompt))
          return streamResult(assistantMessage("stop", [{ type: "text", text: "doctrine cannot support decision" }]));
        return streamResult(
          assistantMessage("toolUse", [
            {
              type: "toolCall",
              id: `record-${scenario.id}`,
              name: "record_raw_candidate",
              arguments: {
                personName: `Prospect ${scenario.id}`,
                profileUrl: `https://www.linkedin.com/in/public-${scenario.id}`,
                source: "search",
                sourceContext: decision,
                evidenceSummary: state,
                bypassIdentityCheck: true,
              },
            },
          ]),
        );
      },
    },
  });
  const modelUrl = new URL("../../src/agent/pi/model.js", import.meta.url).href;
  mock.module(modelUrl, {
    namedExports: {
      LLM_COMPLETE_TIMEOUT_MS: 120_000,
      LLM_STREAM_IDLE_MS: 5_000,
      LLM_STREAM_MAX_RETRIES: 1,
      resolvePiModel: () => ({
        model: { id: "public-doctrine-test", api: "openai-completions" },
        apiKey: "test-key",
        timeoutMs: 120_000,
      }),
    },
  });
  const loop = await import("../../src/agent/pi/loop.js");
  runAgentLoopPi = loop.runAgentLoopPi as RunPi;
});

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function runScenario(system: string, scenario: Scenario, suffix: string) {
  assert.ok(runAgentLoopPi, "real Pi loop imported");
  const directory = await mkdtemp(join(tmpdir(), "frondose-public-sales-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "sales.sqlite");
  const actions: string[] = [];
  const input: ScenarioInput = { id: scenario.id, evidence: scenario.evidence, facts: scenario.facts };
  const messages: CoreMessage[] = [{ role: "user", content: JSON.stringify(input) }];
  const profileUrl = `https://www.linkedin.com/in/public-${scenario.id}/`;
  await runAgentLoopPi({
    model: {},
    system,
    messages,
    tools: { record_raw_candidate: makeRecordRawCandidateTool(databasePath) },
    activeTools: ["record_raw_candidate"],
    maxSteps: 3,
    onToolCall: (name) => actions.push(name),
  });
  const db = openSalesDatabase(databasePath);
  const rows = db
    .prepare(
      "SELECT profile_url AS profileUrl, source_context AS sourceContext, evidence_summary AS evidenceSummary FROM raw_candidates",
    )
    .all() as Array<{ profileUrl: string; sourceContext: string | null; evidenceSummary: string | null }>;
  closeSalesDatabase(databasePath);
  return { actions, messages, rows, profileUrl, suffix };
}

function assertSupported(result: Awaited<ReturnType<typeof runScenario>>, scenario: Scenario): void {
  assert.deepEqual(result.actions, ["record_raw_candidate"], `${scenario.id}/${result.suffix}: real tool order`);
  assert.equal(result.rows.length, 1, `${scenario.id}/${result.suffix}: one durable raw candidate`);
  assert.equal(result.rows[0]?.profileUrl, result.profileUrl);
  assert.equal(result.rows[0]?.sourceContext, scenario.decision);
  assert.equal(result.rows[0]?.evidenceSummary, scenario.state);
  const assistantOutput = JSON.stringify(result.messages.filter((message) => message.role === "assistant"));
  assert.match(assistantOutput, new RegExp(scenario.decision));
}

function assertUnsupported(result: Awaited<ReturnType<typeof runScenario>>, scenario: Scenario): void {
  assert.deepEqual(result.actions, [], `${scenario.id}/${result.suffix}: contradictory doctrine cannot act`);
  assert.equal(result.rows.length, 0, `${scenario.id}/${result.suffix}: contradictory doctrine cannot write state`);
  const assistantOutput = JSON.stringify(result.messages.filter((message) => message.role === "assistant"));
  assert.doesNotMatch(assistantOutput, new RegExp(scenario.decision));
}

describe("the mock carrier exercises Pi-loop, tool, persistence and counterbalancing without claiming LLM semantics", () => {
  it("T-OS.Sales.2-8a: the 24-scenario plumbing oracle executes intact and contradictory variants through the real loop seam", async () => {
    // Given an authored deterministic oracle, when counterbalanced variants run, then the harness—not provider understanding—proves distinct decisions, tool dispatch, and durable state are observable.
    assert.equal(SCENARIOS.length, 24);
    assert.equal(createHash("sha256").update(JSON.stringify(SCENARIOS)).digest("hex"), SCENARIO_CORPUS_SHA256);
    for (let repetition = 0; repetition < 3; repetition++) {
      for (const scenario of SCENARIOS) {
        const mutated = FAMILY_MUTATION[scenario.family](REFERENCE_GENERIC_DOCTRINE);
        assert.notEqual(
          mutated,
          REFERENCE_GENERIC_DOCTRINE,
          `${scenario.family}: mutation must change the tested doctrine`,
        );
        const variants =
          repetition % 2 === 0
            ? ([REFERENCE_GENERIC_DOCTRINE, mutated] as const)
            : ([mutated, REFERENCE_GENERIC_DOCTRINE] as const);
        for (const [index, system] of variants.entries()) {
          const result = await runScenario(system, scenario, `r${repetition + 1}-${index === 0 ? "first" : "second"}`);
          if (system === REFERENCE_GENERIC_DOCTRINE) assertSupported(result, scenario);
          else assertUnsupported(result, scenario);
        }
      }
    }
  });

  it("T-OS.Sales.2-8b: the production-composed Soul satisfies the frozen structural rules used by the plumbing oracle", async () => {
    // Given the actual composed Soul, when structurally checked at the loop seam, then every predeclared generic rule is present; real-model causality remains a Step-5 A/B claim.
    const soul = composeSoulBand({ fullName: "Synthetic Seller", company: "Example Co", updatedAt: "2026-08-01" });
    for (const scenario of SCENARIOS) assertSupported(await runScenario(soul, scenario, "production"), scenario);
  });
});

describe("every discovered methodology carrier has an explicit compatibility disposition", () => {
  it("T-OS.Sales.9: discovery covers prompt, tool, persistence, UI, generated and test owners and fails closed on a new owner", async () => {
    // Given representative carriers plus one newly introduced UI carrier, when inventory runs, then it discovers rather than hides the unreviewed owner.
    const root = await mkdtemp(join(tmpdir(), "frondose-methodology-inventory-"));
    temporaryDirectories.push(root);
    const fixtures = new Map([
      ["src/methodology/distill.ts", "export const METHODOLOGY_DISTILLATION = 'generic';\n"],
      ["src/agent/systemPrompt/soul.ts", "import { METHODOLOGY_DISTILLATION } from '../../methodology/distill.js';\n"],
      ["src/tools/sales/scoreLead.ts", "export const schema = { methodUsed: 'causal' };\n"],
      ["src/persistence/sales/raw-candidates.ts", "export const persistedPhase = 'R1-open';\n"],
      ["src/tauri/ui/methodologyBadge.ts", "export const label = 'enterprise-mapping';\n"],
      ["src/overlay/sharedRenderBundle.generated.ts", "const freeAxis = 'pain_chain_lean';\n"],
      ["src/agent/systemPrompt/consumer.ts", "import './soul.js';\nexport const consumer = true;\n"],
      ["src/generated/map-only-source.ts", "export const tokenFreeGeneratedSource = true;\n"],
      [
        "src/overlay/sharedRenderBundle.generated.js.map",
        JSON.stringify({ version: 3, sources: ["../generated/map-only-source.ts"], names: [], mappings: "" }),
      ],
      ["tests/methodology/carrier.mock.test.ts", "assert.match(prompt, /buyer-owned outcome/);\n"],
    ]);
    for (const [path, content] of fixtures) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content, "utf8");
    }
    const { inventoryMethodologyCarriers } = (await import(pathToFileURL(CONTRACT).href)) as ContractModule;
    const inventory = await inventoryMethodologyCarriers(root);
    for (const path of fixtures.keys())
      assert.ok(
        inventory.some((entry) => entry.path === path),
        `discovery missed ${path}`,
      );
    assert.equal(
      inventory.find((entry) => entry.path === "src/tauri/ui/methodologyBadge.ts")?.disposition,
      "unreviewed",
      "a newly discovered owner must block until explicitly dispositioned",
    );
    assert.ok(
      inventory
        .find((entry) => entry.path === "src/agent/systemPrompt/consumer.ts")
        ?.discoveredBy.some((reason) => reason.startsWith("imported-by:")),
      "a token-free reverse importer must be discovered through the module graph",
    );
    assert.ok(
      inventory
        .find((entry) => entry.path === "src/generated/map-only-source.ts")
        ?.discoveredBy.some((reason) => reason.startsWith("source-map:")),
      "a token-free mapped source must be discovered by traversing sources[]",
    );

    // P-OPEN-SOURCE-SPLIT Step 5: the exported App root is a plain directory (no
    // .git) — fall back to a token walk there; the writable repo keeps the git
    // cross-check.
    const gitCheck = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: process.cwd(), encoding: "utf8" });
    const isGitRepo = gitCheck.status === 0 && gitCheck.stdout.trim() === "true";
    const independentlyDiscovered = isGitRepo
      ? spawnSync(
          "git",
          [
            "grep",
            "-Il",
            "-e",
            "METHODOLOGY_DISTILLATION",
            "-e",
            "methodUsed",
            "-e",
            "R1-open",
            "-e",
            "pain_chain_lean",
            "-e",
            "enterprise-mapping",
            "--",
            "src",
            "tests",
          ],
          { cwd: process.cwd(), encoding: "utf8" },
        )
          .stdout.trim()
          .split("\n")
          .filter(Boolean)
      : (() => {
          const tokens = ["METHODOLOGY_DISTILLATION", "methodUsed", "R1-open", "pain_chain_lean", "enterprise-mapping"];
          const hits: string[] = [];
          const walk = (directory: string): void => {
            for (const entry of readdirSync(directory, { withFileTypes: true })) {
              const full = join(directory, entry.name);
              if (entry.isDirectory()) {
                if (entry.name !== "node_modules") walk(full);
                continue;
              }
              if (!/\.(ts|mjs|js|json|map)$/.test(entry.name)) continue;
              const text = readFileSync(full, "utf8");
              if (tokens.some((token) => text.includes(token))) hits.push(relative(process.cwd(), full));
            }
          };
          walk(process.cwd());
          return hits;
        })();
    assert.ok(independentlyDiscovered.length >= 10, "real repository discovery must be non-empty and broad");
    const realInventory = await inventoryMethodologyCarriers(process.cwd());
    for (const path of independentlyDiscovered) {
      const entry = realInventory.find((candidate) => candidate.path === path);
      assert.ok(entry, `real repository carrier missing from inventory: ${path}`);
      assert.match(entry.disposition, /^(retain|revise-with-stronger-carrier|private-excluded)$/);
      assert.ok(entry.discoveredBy.length > 0, `${path}: discovery reason is required`);
    }
  });
});
