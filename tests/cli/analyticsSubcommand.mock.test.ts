/**
 * P-SP-F Step 5 — T-F.CLI.1/2/3 — analytics subcommand assertions (filled).
 *
 * Assertion bodies FILLED at Step 5.
 *
 * Gates covered:
 *   G-PSPF.11 — T-F.CLI.1, .2, .3a, .3b
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/cli/analyticsSubcommand.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const MAIN_TS = join(REPO, "src/cli/main.ts");

// biome-ignore lint/suspicious/noExplicitAny: pre-builder stubs
type AnyFn = (...args: any[]) => any;

// Dynamic import: analytics.ts does NOT exist pre-builder → resolves to null
// biome-ignore lint/suspicious/noExplicitAny: pre-builder resolution
const analyticsMod = (await import("../../src/cli/subcommands/analytics.js").catch(() => null)) as any;
const runAnalyticsSubcommand: AnyFn = analyticsMod?.runAnalyticsSubcommand ?? null;

// biome-ignore lint/suspicious/noExplicitAny: pre-builder resolution
const dbMod = (await import("../../src/persistence/salesDb.js").catch(() => null)) as any;
const openSalesDatabase: AnyFn = dbMod?.openSalesDatabase ?? null;
const closeSalesDatabase: AnyFn = dbMod?.closeSalesDatabase ?? null;

/** Capture stdout written by fn() into a string. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  let buf = "";
  const origWrite = process.stdout.write.bind(process.stdout);
  // biome-ignore lint/suspicious/noExplicitAny: stdout mock
  (process.stdout as any).write = (chunk: string | Buffer) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  try {
    await fn();
  } finally {
    // biome-ignore lint/suspicious/noExplicitAny: restore
    (process.stdout as any).write = origWrite;
  }
  return buf;
}

/** Create a unique tmp path per test (avoids salesDb singleton collision). */
function makeTmpPath(): string {
  return join(tmpdir(), `sp-f-cli-test-${randomUUID()}.sqlite`);
}

/** Seed a minimal populated sales DB (2 candidates, 1 lead, 5 timeline events, 1 lead_scores, 1 auto_run). */
// biome-ignore lint/suspicious/noExplicitAny: pre-builder DB type
function seedPopulated(db: any): void {
  const now = Date.now();
  const c1 = randomUUID();
  const c2 = randomUUID();
  const l1 = randomUUID();

  db.prepare(`
    INSERT INTO raw_candidates (id, person_name, profile_url, account_id, source,
      observed_at, last_seen_at, status, evidence_summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(c1, "Person A", "https://linkedin.com/in/a/", null, "search", now, now, "promoted", "x");
  db.prepare(`
    INSERT INTO raw_candidates (id, person_name, profile_url, account_id, source,
      observed_at, last_seen_at, status, evidence_summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(c2, "Person B", "https://linkedin.com/in/b/", null, "feed", now, now, "new", "x");

  db.prepare(`
    INSERT INTO leads (id, candidate_id, account_id, person_name, profile_url,
      stage, total_score, confidence, one_line_pain_chain, next_action,
      next_action_due_at, owner_mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    l1,
    c1,
    null,
    "Person A",
    "https://linkedin.com/in/a/",
    "meeting_booked",
    80,
    0.8,
    "pain",
    null,
    null,
    "manual",
    now,
    now,
  );

  // 5 timeline events: connect_sent + connected + message_sent + replied + meeting_booked
  for (const et of ["connect_sent", "connected", "message_sent", "replied", "meeting_booked"] as const) {
    db.prepare(`
      INSERT INTO lead_timeline (id, candidate_id, lead_id, event_type, ts, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), c1, l1, et, now, null);
  }

  // lead_scores (score=80, high band → l1 at meeting_booked = advanced)
  const sc = randomUUID();
  db.prepare(`
    INSERT INTO lead_scores (id, candidate_id, lead_id, total_score, icp_fit,
      pain_hypothesis, buying_trigger, authority_level, suggested_opening_line,
      confidence, next_action, evidence_json, method_used, model, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sc,
    c1,
    l1,
    80,
    "Strong",
    "pain",
    "trigger",
    "VP",
    "opening",
    0.8,
    "next",
    "{}",
    "Pain Chain",
    "deepseek",
    now,
  );

  // auto_runs (completed, 10min ago → durationMinutes=10)
  db.prepare(`
    INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes,
      max_connects, status, summary, counters)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), now - 600000, now, 15, 5, "completed", "Done", JSON.stringify({ connects: 1 }));
}

// ─── T-F.CLI.1 ──────────────────────────────────────────────────────────────────

describe("T-F.CLI.1 — runAnalyticsSubcommand populated DB → stdout lines (G-PSPF.11)", () => {
  it("T-F.CLI.1: when runAnalyticsSubcommand runs on a populated DB, stdout includes funnel:, sources:, rates:, meetings:, score-calibration:, auto-runs: (G-PSPF.11)", async () => {
    // Given: a tmp salesDb path with 2 candidates (search+feed), 1 lead (meeting_booked),
    //        5 timeline events, 1 lead_scores row (high band), 1 auto_runs row (completed)
    // When:  runAnalyticsSubcommand({salesDbPath}) called; stdout captured
    // Then:  captured output includes all 6 required line prefixes:
    //        'funnel:', 'sources:', 'rates:', 'meetings:', 'score-calibration:', 'auto-runs:'
    const path = makeTmpPath();
    const db = openSalesDatabase(path);
    seedPopulated(db);
    // runAnalyticsSubcommand opens via openSalesDatabase (reuses cached handle) then closeSalesDatabase.

    const out = await captureStdout(() => runAnalyticsSubcommand({ salesDbPath: path }));

    // All 6 line prefixes must appear
    assert.ok(out.includes("funnel:"), `stdout must include 'funnel:' line; got:\n${out}`);
    assert.ok(out.includes("sources:"), `stdout must include 'sources:' line; got:\n${out}`);
    assert.ok(out.includes("rates:"), `stdout must include 'rates:' line; got:\n${out}`);
    assert.ok(out.includes("meetings:"), `stdout must include 'meetings:' line; got:\n${out}`);
    assert.ok(out.includes("score-calibration:"), `stdout must include 'score-calibration:' line; got:\n${out}`);
    assert.ok(out.includes("auto-runs:"), `stdout must include 'auto-runs:' line; got:\n${out}`);

    // Spot-check key values
    assert.ok(out.includes("meeting_booked=1"), `stdout must show meeting_booked=1; got:\n${out}`);
    assert.ok(out.includes("booked=1"), `stdout must show booked=1 in meetings: line; got:\n${out}`);
    // sources: 2 candidates (1 search, 1 feed)
    assert.ok(out.includes("search="), `stdout must include search source; got:\n${out}`);
    assert.ok(out.includes("feed="), `stdout must include feed source; got:\n${out}`);
    // score-calibration: high band present
    assert.ok(out.includes("high (70-100)"), `stdout must include high band; got:\n${out}`);
    // auto-runs: 1 completed run
    assert.ok(out.includes("1 completed"), `stdout must show 1 completed run; got:\n${out}`);
  });
});

// ─── T-F.CLI.2 ──────────────────────────────────────────────────────────────────

describe("T-F.CLI.2 — runAnalyticsSubcommand empty DB → zeros + n/a, no crash (G-PSPF.11)", () => {
  it("T-F.CLI.2: when runAnalyticsSubcommand runs on a freshly initialized (empty) DB, all counts show 0 and null rates display as n/a without crash (G-PSPF.11)", async () => {
    // Given: a tmp salesDb path opened with openSalesDatabase (schema applied),
    //        no rows seeded, closeSalesDatabase called to flush before analytics run
    // When:  runAnalyticsSubcommand({salesDbPath}) called; stdout captured
    // Then:  no exception thrown; stdout contains 'funnel:' line with all zeros;
    //        stdout contains 'rates:' line with 'n/a' for null rates;
    //        stdout does NOT contain 'score-calibration:' or 'auto-runs:' lines
    //        (analytics.ts skips both lines when their arrays are empty)
    const path = makeTmpPath();
    // Open to create the schema+file, then close so the file is flushed to disk
    openSalesDatabase(path);
    closeSalesDatabase(path);

    let threw = false;
    let out = "";
    try {
      out = await captureStdout(() => runAnalyticsSubcommand({ salesDbPath: path }));
    } catch {
      threw = true;
    }
    assert.equal(threw, false, "runAnalyticsSubcommand must not throw on empty DB");

    // funnel: line must appear with all-zero discovered
    assert.ok(out.includes("funnel:"), `stdout must include 'funnel:' line; got:\n${out}`);
    assert.ok(out.includes("discovered=0"), `stdout must show discovered=0; got:\n${out}`);
    assert.ok(out.includes("meeting_booked=0"), `stdout must show meeting_booked=0; got:\n${out}`);

    // rates: line must appear with 'n/a' for null rates
    assert.ok(out.includes("rates:"), `stdout must include 'rates:' line; got:\n${out}`);
    assert.ok(out.includes("n/a"), `stdout must include 'n/a' for null rates (OQ-F6); got:\n${out}`);

    // meetings: line must appear
    assert.ok(out.includes("meetings:"), `stdout must include 'meetings:' line; got:\n${out}`);
    assert.ok(out.includes("booked=0"), `stdout must show booked=0 (empty DB); got:\n${out}`);

    // score-calibration: and auto-runs: must NOT appear (Sketch D skips empty arrays)
    assert.ok(
      !out.includes("score-calibration:"),
      `stdout must NOT contain 'score-calibration:' for empty DB; got:\n${out}`,
    );
    assert.ok(!out.includes("auto-runs:"), `stdout must NOT contain 'auto-runs:' for empty DB; got:\n${out}`);
  });
});

// ─── T-F.CLI.3 ──────────────────────────────────────────────────────────────────

describe("T-F.CLI.3 — analytics subcommand wiring: main.ts registration (G-PSPF.11)", () => {
  it("T-F.CLI.3a: src/cli/main.ts source contains program.command('analytics') AND import of runAnalyticsSubcommand (G-PSPF.11)", () => {
    // Given: src/cli/main.ts source post-builder (Sketch E pasted)
    // When:  source text scanned for wiring signals
    // Then:  main.ts contains program.command("analytics") (or single quotes)
    //        AND contains 'runAnalyticsSubcommand'
    const mainSrc = readFileSync(MAIN_TS, "utf-8");
    assert.ok(
      mainSrc.includes('.command("analytics")'),
      `main.ts must register .command("analytics") (Sketch E wiring); found: ${mainSrc.slice(0, 200)}`,
    );
    assert.ok(
      mainSrc.includes("runAnalyticsSubcommand"),
      "main.ts must import and reference runAnalyticsSubcommand (Sketch E wiring)",
    );
  });

  it("T-F.CLI.3b: src/cli/subcommands/analytics.ts module exports runAnalyticsSubcommand as a function (G-PSPF.11)", async () => {
    // Given: src/cli/subcommands/analytics.ts built + importable (post-builder)
    // When:  runAnalyticsSubcommand resolved from dynamic import at top of file
    // Then:  typeof runAnalyticsSubcommand === 'function' (not null / undefined)
    assert.equal(
      typeof runAnalyticsSubcommand,
      "function",
      "runAnalyticsSubcommand must be exported as a function from analytics.ts (Sketch D)",
    );
  });
});
