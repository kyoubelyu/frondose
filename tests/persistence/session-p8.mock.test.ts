/**
 * P-8 mock tests — T-Session-P8.1..T-Session-P8.4
 *
 * Tests for rewriteSession() and writeCompactionMarker() added to
 * src/persistence/session.ts in P-8 (§6.7).
 *
 * T-Session-P8.1 — rewriteSession: writes to ${file}.tmp, then renames atomically
 * T-Session-P8.2 — rewriteSession: empty messages array → empty file (not a JSONL line)
 * T-Session-P8.3 — writeCompactionMarker: writes ${sessionFile}.compact.json sidecar
 * T-Session-P8.4 — loadMessages: NOT broken by the P-8 additions (regression)
 *
 * Gate coverage: G-P8.1 (session rewrite + sidecar), G-P8.7 (no regression)
 *
 * No LLM, no Chrome.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CoreMessage } from "ai";
import { loadMessages, rewriteSession, writeCompactionMarker } from "../../src/persistence/session.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p8-session-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeMessages(count: number): CoreMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `message-${i}`,
  }));
}

// ─── T-Session-P8.1: rewriteSession atomic rename ─────────────────────────────

test("T-Session-P8.1: rewriteSession writes to .tmp then renames; .tmp does not exist after call", () => {
  const { dir, cleanup } = makeTempDir();
  try {
    const sessionFile = join(dir, "session.jsonl");
    const tmpFile = `${sessionFile}.tmp`;

    // Pre-create the session file with old content to verify overwrite
    writeFileSync(sessionFile, '{"role":"user","content":"old"}\n', "utf-8");

    const messages: CoreMessage[] = makeMessages(3);
    rewriteSession(sessionFile, messages);

    // .tmp must NOT exist (it was renamed to sessionFile)
    assert.ok(!existsSync(tmpFile), `.tmp file must not exist after rename; path: ${tmpFile}`);

    // sessionFile must exist with the new content
    assert.ok(existsSync(sessionFile), "session file must exist after rewrite");

    const content = readFileSync(sessionFile, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 3, "session file must contain 3 JSONL lines");

    // Verify each line is valid JSON matching the messages
    for (let i = 0; i < 3; i++) {
      const parsed = JSON.parse(lines[i] ?? "{}") as CoreMessage;
      assert.equal(parsed.role, messages[i]?.role, `line ${i} role matches`);
      assert.equal(parsed.content, messages[i]?.content, `line ${i} content matches`);
    }

    // Old content must be gone
    assert.ok(!content.includes('"old"'), "old content replaced");
  } finally {
    cleanup();
  }
});

// ─── T-Session-P8.2: rewriteSession with empty messages array ─────────────────

test("T-Session-P8.2: rewriteSession with empty messages → empty file (not a blank line)", () => {
  const { dir, cleanup } = makeTempDir();
  try {
    const sessionFile = join(dir, "empty.jsonl");
    writeFileSync(sessionFile, '{"role":"user","content":"old"}\n', "utf-8");

    rewriteSession(sessionFile, []);

    assert.ok(existsSync(sessionFile), "session file exists");
    const content = readFileSync(sessionFile, "utf-8");
    assert.equal(content, "", "empty messages → empty file (zero bytes)");
  } finally {
    cleanup();
  }
});

// ─── T-Session-P8.3: writeCompactionMarker sidecar ───────────────────────────

// biome-ignore lint/suspicious/noTemplateCurlyInString: test name documents the literal path pattern
test("T-Session-P8.3: writeCompactionMarker writes sidecar at ${sessionFile}.compact.json", () => {
  const { dir, cleanup } = makeTempDir();
  try {
    const sessionFile = join(dir, "session.jsonl");
    const sidecarPath = `${sessionFile}.compact.json`;

    const marker = {
      type: "compaction" as const,
      ts: "2026-05-10T12:00:00.000Z",
      summarizedCount: 8,
      keptCount: 10,
      model: "openai:deepseek-v4-flash",
    };

    writeCompactionMarker(sessionFile, marker);

    // Sidecar must exist at the correct path
    assert.ok(existsSync(sidecarPath), `sidecar must exist at ${sidecarPath}`);

    // Sidecar content must be valid JSON matching the marker
    const content = readFileSync(sidecarPath, "utf-8");
    const parsed = JSON.parse(content) as typeof marker;
    assert.equal(parsed.type, "compaction");
    assert.equal(parsed.summarizedCount, 8);
    assert.equal(parsed.keptCount, 10);
    assert.equal(parsed.model, "openai:deepseek-v4-flash");
    assert.equal(parsed.ts, "2026-05-10T12:00:00.000Z");

    // Sidecar must be a SIBLING of the session file, not nested inside it
    assert.ok(sidecarPath.startsWith(dir), "sidecar is in the same dir as session file");
    assert.ok(!sidecarPath.endsWith(".jsonl"), "sidecar does NOT have .jsonl extension");
    assert.ok(sidecarPath.endsWith(".compact.json"), "sidecar has .compact.json extension");
  } finally {
    cleanup();
  }
});

// ─── T-Session-P8.4: loadMessages regression — P-8 additions don't break it ──

test("T-Session-P8.4: loadMessages still works correctly after P-8 additions (regression)", () => {
  const { dir, cleanup } = makeTempDir();
  try {
    const sessionFile = join(dir, "regression.jsonl");

    // Write messages in JSONL format (as rewriteSession would produce)
    const messages: CoreMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "[Previous conversation summary by /compact]\n\nSummary text." },
    ];
    rewriteSession(sessionFile, messages);

    // loadMessages should parse all 3 lines without issues
    const loaded = loadMessages(sessionFile);
    assert.equal(loaded.length, 3, "loadMessages reads all 3 messages");
    assert.equal(loaded[0]?.role, "user");
    assert.equal(loaded[0]?.content, "hello");
    assert.equal(loaded[1]?.role, "assistant");
    assert.equal(loaded[2]?.role, "user");
    // The summary head content should be preserved verbatim
    assert.ok(
      (loaded[2]?.content as string).includes("[Previous conversation summary by /compact]"),
      "compaction summary head preserved by loadMessages",
    );
  } finally {
    cleanup();
  }
});

// ─── T-Session-P8.5: rewriteSession round-trip via loadMessages ───────────────

test("T-Session-P8.5: rewriteSession + loadMessages round-trip (D-10 atomicity verification)", () => {
  const { dir, cleanup } = makeTempDir();
  try {
    const sessionFile = join(dir, "round-trip.jsonl");
    const original: CoreMessage[] = makeMessages(15);

    // Write original via appendFileSync pattern (as appendMessages would)
    const origLines = `${original.map((m) => JSON.stringify(m)).join("\n")}\n`;
    writeFileSync(sessionFile, origLines, "utf-8");

    // Build new messages (simulate compaction result)
    const summaryHead: CoreMessage = {
      role: "user",
      content: "[Previous conversation summary by /compact]\n\nFirst 5 messages about LinkedIn prospecting.",
    };
    const tail = original.slice(5);
    const newMessages: CoreMessage[] = [summaryHead, ...tail];

    rewriteSession(sessionFile, newMessages);

    // loadMessages should correctly parse the rewritten file
    const loaded = loadMessages(sessionFile);
    assert.equal(loaded.length, 11, "round-trip: 1 summary + 10 tail");
    assert.equal(loaded[0]?.role, "user");
    assert.ok((loaded[0]?.content as string).includes("[Previous conversation summary by /compact]"));
    // Tail messages preserved
    for (let i = 1; i < 11; i++) {
      assert.deepEqual(loaded[i], tail[i - 1], `tail[${i - 1}] preserved`);
    }
  } finally {
    cleanup();
  }
});
