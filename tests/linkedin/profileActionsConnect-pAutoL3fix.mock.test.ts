/**
 * P-AUTO-L3FIX-1 Step 3a (Scaffold Revision) — Test Scaffold
 * T-Connect.1–4 (B1 — Connect-under-More affordance in PROFILE_ACTIONS_SYNTH_JS)
 *
 * Workstream covered: B1
 *
 * All assertion bodies are assert.fail("TODO: …") — compile-only, ALL-FAILING.
 * Builder Step 4 lands the PROFILE_ACTIONS_SYNTH_JS hint emission.
 * Validator Step 5 fills assertion bodies.
 *
 * ── Step 3a changes from Step 2 scaffold ──────────────────────────────────────
 *
 * BLOCKER-3 fix (T-Connect.1 + T-Connect.2 — source-text pins → behavioral):
 *   The Step-2 scaffold used `readFileSync(snapshotCapture.ts)` and checked string
 *   presence (e.g. `.includes("hasMore")`). This is a source-text pin — it would pass
 *   even if the guard existed but emitted `role:"hint"` (invisible to the LLM).
 *   It cannot catch the BLOCKER-2 invisible-hint bug the Codex critic found.
 *
 *   Step 3a fix: evaluate PROFILE_ACTIONS_SYNTH_JS in a fake DOM using Node.js `vm`
 *   (the same pattern used by tests/cdp/stealth.mock.test.ts which evaluates
 *   STEALTH_INIT_SCRIPT via vm.runInNewContext). Extract the PROFILE_ACTIONS_SYNTH_JS
 *   constant from the snapshotCapture module, build a minimal fake `document`/`window`
 *   context with the desired DOM shape, run the IIFE in that context, parse the returned
 *   JSON, and pass the resulting entries through `buildInspectSummary(ctx, undefined)`.
 *   THEN assert the product-visible output: `.text` contains the hint (T-Connect.1) /
 *   does NOT contain the hint (T-Connect.2 per-fixture). This catches the invisible-hint
 *   bug (role:"hint" ∉ TEXT_ROLES → dropped from .text) and the false-positive bug
 *   (hasConnectish guard too narrow for "Invite <name> to connect").
 *
 *   Why vm over jsdom: no jsdom/linkedom dependency in this repo (package.json grep-verified).
 *   PROFILE_ACTIONS_SYNTH_JS is a plain IIFE using only DOM APIs (querySelector/querySelectorAll,
 *   getAttribute, innerText, getBoundingClientRect, compareDocumentPosition, Node.DOCUMENT_POSITION_FOLLOWING,
 *   title). We build a minimal fake document in JS objects and pass it as the vm sandbox's
 *   `document` — sufficient for the IIFE's queries, since we control the fixture shape.
 *
 *   The fake `document` factory (`makeProfileActionDocument`) takes:
 *   - `title`: the page title (used to extract `name` by PROFILE_ACTIONS_SYNTH_JS)
 *   - `actions`: array of {ariaLabel, tagName, role} tuples representing the action
 *     buttons the IIFE should find
 *   It returns a minimal document-like object the IIFE can call `.title`, `.match()`,
 *   `.querySelectorAll()`, `.closest()`, `.getAttribute()`, `.innerText`, and the
 *   `compareDocumentPosition` / `DOCUMENT_POSITION_FOLLOWING` Node constant on.
 *
 * BLOCKER-4 fix (T-Connect.3 role update + visibility assertion):
 *   Step 2 scaffold used role:"hint" (which is invisible — ∉ TEXT_ROLES). The architect
 *   switched to role:"text" at Step 3a. T-Connect.3 updated to assert the entry with
 *   role:"text" is NOT clickable AND IS visible in buildInspectSummary().text.
 *
 * ── Fixture rationale ─────────────────────────────────────────────────────────
 *
 * Three fixture types for T-Connect.1/2:
 *   1. FOLLOW-PRIMARY: page title "José David | LinkedIn"; action row has
 *      Follow, Message, "More actions for José David" — NO Connect/Pending/Following.
 *      B1 hint MUST appear in .text.
 *   2. TOP-LEVEL-CONNECT: action row has bare "Connect" button (no More).
 *      B1 hint must NOT appear (hasConnectish suppresses it).
 *   3. INVITE-FORM: action row has "Invite José David to connect" (the `invite…to connect`
 *      ACTION_RE form from snapshotCapture.ts:115).
 *      B1 hint must NOT appear (widened hasConnectish catches this — CONCERN-MR fix).
 *   (+ PENDING and FOLLOWING variants as parametrized sub-cases of T-Connect.2)
 *
 * No real Chrome required. No jsdom. Node:vm only.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, it } from "node:test";
import { buildInspectSummary, CLICKABLE_ROLES, TEXT_ROLES } from "../../src/linkedin/inspectSummary.js";
import { resolveByLabel } from "../../src/linkedin/labelResolver.js";
import { classifyOutboundLabel } from "../../src/tools/browser/outboundGuard.js";
import type { CurrentSurfaceContext, SnapshotEntry } from "../../src/linkedin/types.js";

// ─── Extract PROFILE_ACTIONS_SYNTH_JS from source (Step 5: not exported, use readFileSync) ──
// PROFILE_ACTIONS_SYNTH_JS is a `const` (not exported) in snapshotCapture.ts.
// We extract the IIFE body by finding the const in the source and extracting the template literal.
// The IIFE body is the content of the template literal: `(() => { ... })()`.
// We extract from the first `\`(()` to the matching closing `` ` `` before `; export` or end.
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SNAPSHOT_CAPTURE_SRC = readFileSync(
  join(REPO, "src/linkedin/snapshotCapture.ts"),
  "utf-8",
);

// Extract and evaluate PROFILE_ACTIONS_SYNTH_JS from the source file.
// The constant is defined as: const PROFILE_ACTIONS_SYNTH_JS = `...`;
// We extract the template literal source and evaluate it via `new Function` to get the
// actual runtime string (resolving template literal escape sequences like \\s → \s in regexes).
// This is necessary because readFileSync returns the raw TS source bytes, where `\\s` is
// the literal two characters that at JS runtime become `\s` (a regex escape). If we passed
// the raw source bytes directly to vm.runInNewContext, the regexes would be wrong.
function extractProfileActionsSynthJs(src: string): string {
  const constMarker = "const PROFILE_ACTIONS_SYNTH_JS = `";
  const start = src.indexOf(constMarker);
  if (start === -1) throw new Error("PROFILE_ACTIONS_SYNTH_JS not found in snapshotCapture.ts");
  const backtickStart = src.indexOf("`", start);
  if (backtickStart === -1) throw new Error("opening backtick for PROFILE_ACTIONS_SYNTH_JS not found");
  // Find the closing backtick: `;\n (template literal terminates before semicolon+newline)
  const backtickEnd = src.indexOf("`;\n", backtickStart + 1);
  if (backtickEnd === -1) throw new Error("closing backtick for PROFILE_ACTIONS_SYNTH_JS not found");
  // The raw extracted content includes TypeScript-level escape sequences (e.g., \\s → two chars).
  // Evaluate via new Function to resolve those escapes to their runtime values.
  const rawContent = src.slice(backtickStart, backtickEnd + 1); // includes surrounding backticks
  // biome-ignore lint/security/noGlobalEval: test-only; needed to resolve template literal escapes
  const result = new Function(`return ${rawContent}`)() as string;
  return result;
}

const PROFILE_ACTIONS_SYNTH_JS: string = extractProfileActionsSynthJs(SNAPSHOT_CAPTURE_SRC);

// ─── Fake DOM factory ─────────────────────────────────────────────────────────

/**
 * A fake DOM element suitable for the PROFILE_ACTIONS_SYNTH_JS IIFE.
 * The IIFE calls:
 *   el.getAttribute('aria-label'), el.innerText, el.tagName, el.getAttribute('role'),
 *   el.closest(EXCL), el.setAttribute('data-frondose-pa', ...), h1.compareDocumentPosition(el),
 *   Node.DOCUMENT_POSITION_FOLLOWING (the constant 4).
 */
interface FakeEl {
  tagName: string;
  _ariaLabel: string;
  _innerText: string;
  _role: string;
  _closestExcl: boolean; // true = is inside an excluded ancestor (aside/nav/etc.)
  _dataFrondosePA?: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  closest(sel: string): FakeEl | null;
  readonly innerText: string;
  compareDocumentPosition(other: FakeEl): number;
}

function makeFakeEl(opts: {
  tagName: string;
  ariaLabel: string;
  innerText?: string;
  role?: string;
  insideExcluded?: boolean;
}): FakeEl {
  const el: FakeEl = {
    tagName: opts.tagName.toUpperCase(),
    _ariaLabel: opts.ariaLabel,
    _innerText: opts.innerText ?? opts.ariaLabel,
    _role: opts.role ?? (opts.tagName.toUpperCase() === "A" ? "" : "button"),
    _closestExcl: opts.insideExcluded ?? false,
    get innerText() { return this._innerText; },
    getAttribute(name: string): string | null {
      if (name === "aria-label") return this._ariaLabel || null;
      if (name === "role") return this._role || null;
      return null;
    },
    setAttribute(name: string, value: string): void {
      if (name === "data-frondose-pa") this._dataFrondosePA = value;
    },
    closest(sel: string): FakeEl | null {
      // Return non-null if this element is "inside" an excluded selector.
      // The IIFE passes EXCL = "[role='banner'],[role='navigation'],nav,header,aside,[role='complementary']"
      if (this._closestExcl) return {} as FakeEl; // truthy → excluded
      return null;
    },
    compareDocumentPosition(_other: FakeEl): number {
      // Always return Node.DOCUMENT_POSITION_FOLLOWING (4) so the IIFE thinks
      // all action candidates follow the h1. This makes the IIFE's h1-anchored
      // button-picker accept all our fake buttons.
      return 4; // Node.DOCUMENT_POSITION_FOLLOWING
    },
  };
  return el;
}

/**
 * Build a minimal fake `document` for the PROFILE_ACTIONS_SYNTH_JS IIFE.
 *
 * The IIFE reads:
 *   document.title           → to extract person name
 *   document.querySelectorAll("h1,h2,h3") → to find the h1
 *   h1.closest(...)          → excluded-ancestor check
 *   h1.closest("section") / h1.parentElement → card root walk
 *   card.querySelector(...)  → action-row detection
 *   card.querySelectorAll("button,a[role='button'],a[aria-label]") → action candidates
 *   el.closest(EXCL)         → filter excluded
 *   el.getAttribute('aria-label'), el.innerText → label
 *   el.getAttribute('role')  → role classification
 *   el.setAttribute(...)     → mark the element
 *   h1.compareDocumentPosition(el) → ordering check
 */
function makeProfileActionDocument(opts: {
  name: string; // person name (becomes document.title "Name | LinkedIn")
  actions: Array<{ ariaLabel: string; tagName?: string; role?: string; insideExcluded?: boolean }>;
}): vm.Context {
  const title = `${opts.name} | LinkedIn`;

  // Build fake action elements
  const actionEls = opts.actions.map((a) =>
    makeFakeEl({
      tagName: a.tagName ?? "button",
      ariaLabel: a.ariaLabel,
      role: a.role,
      insideExcluded: a.insideExcluded,
    }),
  );

  // Fake h1 element (represents the person's name heading)
  const fakeH1: FakeEl = makeFakeEl({
    tagName: "H1",
    ariaLabel: "",
    innerText: opts.name,
    insideExcluded: false,
  });

  // Override querySelector/querySelectorAll for the card root:
  // The IIFE walks up from h1 to find a card with action-row buttons, then queries the card.
  // We shortcut: the h1's closest("section") is the card, and the card's querySelectorAll
  // for action candidates returns our action elements.
  const fakeCard = {
    querySelector(sel: string): FakeEl | null {
      // Return truthy if the card contains the selector (so the IIFE stops climbing).
      // We always stop at the first hop by returning a dummy for the action-detection selectors.
      if (
        sel.includes("More") ||
        sel.includes("connect") ||
        sel.includes("Message")
      ) {
        return actionEls[0] ?? null;
      }
      return null;
    },
    querySelectorAll(_sel: string): FakeEl[] {
      // Return all our fake action elements (simulates "button,a[role='button'],a[aria-label]")
      return actionEls;
    },
    parentElement: null,
  };

  // The h1's closest("section") returns the fakeCard
  fakeH1.closest = (sel: string): FakeEl | null => {
    if (sel === "section" || sel.includes("section")) return fakeCard as unknown as FakeEl;
    if (fakeH1._closestExcl) return {} as FakeEl;
    return null;
  };

  // Fake document object
  const fakeDocument = {
    title,
    querySelectorAll(sel: string): FakeEl[] {
      if (sel === "h1,h2,h3" || sel.includes("h1")) return [fakeH1];
      return [];
    },
    querySelector(_sel: string): FakeEl | null {
      return null;
    },
  };

  // Provide Node.DOCUMENT_POSITION_FOLLOWING as a constant in the sandbox,
  // plus Array/JSON/RegExp/String globals needed by the IIFE (vm.runInNewContext
  // creates a minimal context — built-ins must be explicitly provided).
  return {
    document: fakeDocument,
    JSON,
    Array,
    RegExp,
    String,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
  };
}

/**
 * Evaluate PROFILE_ACTIONS_SYNTH_JS against a fake document and return the parsed result.
 * Returns null if the synth JS is not yet available (pre-fix scaffold state).
 */
function evalSynthJs(
  synthJs: string,
  ctx: vm.Context,
): { name: string | null; actions: Array<{ i: number; role: string; label: string }> } | null {
  try {
    const raw = vm.runInNewContext(synthJs, ctx) as string;
    return JSON.parse(raw) as { name: string | null; actions: Array<{ i: number; role: string; label: string }> };
  } catch {
    return null;
  }
}

/**
 * Convert synth output into SnapshotEntry[] (simulates synthesizeProfileActionEntries
 * WITHOUT the CDP describeNode round-trip — we give each entry a fake ref).
 * This is sufficient for testing buildInspectSummary's text/button routing.
 */
function synthToEntries(
  info: { name: string | null; actions: Array<{ i: number; role: string; label: string }> } | null,
): SnapshotEntry[] {
  if (!info || !Array.isArray(info.actions)) return [];
  return info.actions.map((a) => ({
    ref: a.i === -1 ? "" : `@pa${a.i}`,
    role: a.role as string,
    name: a.label,
  }));
}

/**
 * Build a minimal CurrentSurfaceContext with the given entries on the profile surface.
 * Used to drive buildInspectSummary.
 */
function makeProfileCtx(entries: SnapshotEntry[]): CurrentSurfaceContext {
  return {
    pageUrl: "https://www.linkedin.com/in/test-person/",
    surface: "profile",
    activeLayer: "page",
    entries,
  };
}

// ─── B1 — Connect-under-More synth behavior ───────────────────────────────────

describe("B1 — Connect-under-More: PROFILE_ACTIONS_SYNTH_JS hint emission + buildInspectSummary routing", () => {

  // ─── T-Connect.1 ────────────────────────────────────────────────────────────
  it("T-Connect.1: when action row has Follow+Message+More but no top-level Connect/Pending/Following/Invite-to-connect, synth emits a hint entry with role:'text' that appears in buildInspectSummary().text AND NOT in .buttons (visible-but-non-clickable)", async () => {
    // Given: a FOLLOW-PRIMARY profile fixture — document.title = "José David | LinkedIn";
    //        action row: Follow, Message, "More actions for José David" (no Connect/Pending/Following)
    // When:  PROFILE_ACTIONS_SYNTH_JS evaluated against the fixture
    //        AND the resulting entries (incl. the hint) passed through buildInspectSummary(ctx)
    // Then:  (a) One entry with role:"text" and label containing "Connect" and "More" and "overlay" is present
    //        (b) buildInspectSummary(ctx).text contains a line matching the hint label
    //        (c) buildInspectSummary(ctx).buttons does NOT contain any entry whose label includes
    //            "Connect" and "More" (the hint is not clickable)
    //        (d) TEXT_ROLES.has("text") === true (sanity pin — role is valid)
    //        (e) CLICKABLE_ROLES.has("text") === false (non-clickability proof)
    const docCtx = makeProfileActionDocument({
      name: "José David",
      actions: [
        { ariaLabel: "Follow José David" },
        { ariaLabel: "Message José David" },
        { ariaLabel: "More actions for José David" },
      ],
    });
    const info = evalSynthJs(PROFILE_ACTIONS_SYNTH_JS, docCtx);
    const entries = synthToEntries(info);
    const ctx = makeProfileCtx(entries);
    const summary = buildInspectSummary(ctx);

    const hintEntry = entries.find(
      (e) => e.role === "text" && e.name.toLowerCase().includes("connect") && e.name.toLowerCase().includes("more"),
    );
    const textHasHint = summary.text.some(
      (t) => t.toLowerCase().includes("connect") && t.toLowerCase().includes("more"),
    );
    const buttonHasHint = summary.buttons.some(
      (b) => b.label.toLowerCase().includes("connect") && b.label.toLowerCase().includes("more"),
    );

    // (a) hint entry must exist with role:"text" (not "hint" — BLOCKER-2 fix)
    assert.ok(hintEntry !== undefined,
      `hint entry with role:'text' containing "Connect" and "More" must exist. entries=${JSON.stringify(entries)}`);
    assert.equal(hintEntry?.role, "text", "hint entry must have role:'text' (not 'hint' — BLOCKER-2 fix)");
    assert.ok(hintEntry?.name.toLowerCase().includes("overlay"),
      `hint label must mention "overlay". Got: "${hintEntry?.name}"`);

    // (b) buildInspectSummary(..).text must contain the hint (role:"text" ∈ TEXT_ROLES)
    assert.ok(textHasHint,
      `buildInspectSummary().text must contain the hint line. text=${JSON.stringify(summary.text)}`);

    // (c) .buttons must NOT contain the hint (role:"text" ∉ CLICKABLE_ROLES)
    assert.ok(!buttonHasHint,
      `buildInspectSummary().buttons must NOT contain the hint. buttons=${JSON.stringify(summary.buttons)}`);

    // (d) TEXT_ROLES sanity pin
    assert.ok(TEXT_ROLES.has("text"), "TEXT_ROLES must include 'text'");

    // (e) non-clickability proof
    assert.ok(!CLICKABLE_ROLES.has("text"), "CLICKABLE_ROLES must NOT include 'text'");
  });

  // ─── T-Connect.2 ────────────────────────────────────────────────────────────
  it("T-Connect.2: when action row has a top-level Connect/Pending/Following/Invite-to-connect, NO hint appears in buildInspectSummary().text (widened hasConnectish guard)", async () => {
    // Given: four fixtures each with a real top-level connect affordance
    // When:  PROFILE_ACTIONS_SYNTH_JS evaluated against each + buildInspectSummary
    // Then:  NO hint line for any fixture (hasConnectish suppresses it)
    const fixtures = [
      { label: "Connect", desc: "bare Connect" },
      { label: "Pending", desc: "Pending (sent)" },
      { label: "Following", desc: "Following (already)" },
      { label: "Invite José David to connect", desc: "Invite-to-connect (CONCERN-MR)" },
    ];

    const results = fixtures.map(({ label, desc }) => {
      const docCtx = makeProfileActionDocument({
        name: "José David",
        actions: [
          { ariaLabel: label },
          { ariaLabel: "Message José David" },
          { ariaLabel: "More actions for José David" },
        ],
      });
      const info = evalSynthJs(PROFILE_ACTIONS_SYNTH_JS, docCtx);
      const entries = synthToEntries(info);
      const ctx = makeProfileCtx(entries);
      const summary = buildInspectSummary(ctx);
      const textHasHint = summary.text.some(
        (t) => t.toLowerCase().includes("connect") && t.toLowerCase().includes("more") && t.toLowerCase().includes("overlay"),
      );
      return { desc, label, textHasHint };
    });

    const failingFixtures = results.filter((r) => r.textHasHint);
    assert.equal(
      failingFixtures.length,
      0,
      `hint must NOT be emitted when a real connect affordance exists. Failing: ${JSON.stringify(failingFixtures)}. ` +
      `All results: ${JSON.stringify(results)}. ` +
      `"Invite José David to connect" specifically tests the widened hasConnectish guard.`,
    );
  });

  // ─── T-Connect.3 ────────────────────────────────────────────────────────────
  it("T-Connect.3: given the hint entry with role:'text' + ref:'', resolveByLabel does NOT resolve it to a clickable ref (CLICKABLE_ROLES excludes 'text'); AND the entry IS visible in buildInspectSummary().text (paired visibility + non-clickability pin)", () => {
    // Given: a SnapshotEntry with role:"text" + ref:"" (the Connect-under-More affordance)
    //        and one resolvable button entry as a control
    // When:  (a) resolveByLabel(entries, "Connect", {kind:"click"}) is called
    //        (b) buildInspectSummary(makeProfileCtx(entries)).text is inspected
    // Then:  (a) does NOT resolve the hint (role:"text" is not in CLICKABLE_ROLES → filtered at labelResolver.ts:30)
    //            Either throws no-match or returns @pm1 (the button), NOT the hint's empty ref
    //        (b) .text CONTAINS the hint label (role:"text" ∈ TEXT_ROLES → visible to LLM)
    //
    // This pairs T-Connect.1's visibility proof with T-Connect.3's non-clickability proof.
    // Also updated from Step 2 scaffold: role changed from "hint" to "text" per Step-3a architect decision.
    //
    // NOTE on role:"text": TEXT_ROLES.has("text") === true (inspectSummary.ts:24) → visible.
    //       CLICKABLE_ROLES.has("text") === false (inspectSummary.ts:4-15) → non-clickable.
    //       resolveByLabel role-gates by CLICKABLE_ROLES at labelResolver.ts:30 → "text" filtered.
    const hintLabel = 'Connect is under "More" — click the profile "More" action (@pm1), then inspect scope:"overlay" and click "Connect".';
    const entries: SnapshotEntry[] = [
      {
        ref: "",
        role: "text",
        name: hintLabel,
      },
      { ref: "@pm1", role: "button", name: "More actions for José David" },
    ];

    const ctx = makeProfileCtx(entries);
    const summary = buildInspectSummary(ctx);
    const textHasHint = summary.text.some((t) => t.includes("Connect") && t.includes("More") && t.includes("overlay"));
    const buttonHasHint = summary.buttons.some((b) => b.label.includes("Connect") && b.label.includes("More"));

    // Try resolveByLabel — should throw (no "Connect" match in CLICKABLE_ROLES) or return @pm1
    let resolveResult: SnapshotEntry | null = null;
    let resolveThrew = false;
    try {
      resolveResult = resolveByLabel(entries, "Connect", { kind: "click" });
    } catch {
      resolveThrew = true;
    }

    // (a) hint must be VISIBLE in .text (role:"text" ∈ TEXT_ROLES)
    assert.ok(textHasHint,
      `hint must appear in buildInspectSummary().text (role:"text" ∈ TEXT_ROLES). text=${JSON.stringify(summary.text)}`);

    // (b) hint must NOT be in .buttons (role:"text" ∉ CLICKABLE_ROLES)
    assert.ok(!buttonHasHint,
      `hint must NOT appear in buildInspectSummary().buttons (role:"text" ∉ CLICKABLE_ROLES). buttons=${JSON.stringify(summary.buttons)}`);

    // (c) resolveByLabel must NOT resolve the hint as clickable
    // It either throws (no match for "Connect" among CLICKABLE_ROLES entries) OR returns @pm1 (the button).
    assert.ok(
      resolveThrew || resolveResult?.ref === "@pm1",
      `resolveByLabel for "Connect" with role:"text" hint must throw or return @pm1, not the hint. ` +
      `resolveThrew=${resolveThrew}, resolveResult=${JSON.stringify(resolveResult)}`,
    );
    // Must NOT resolve to the empty ref (hint's ref:"" would be wrong)
    assert.notEqual(resolveResult?.ref, "", "resolveByLabel must NOT return the hint's empty ref");

    // (d) TEXT_ROLES sanity pin
    assert.ok(TEXT_ROLES.has("text"), "TEXT_ROLES must include 'text'");

    // (e) CLICKABLE_ROLES exclusion
    assert.ok(!CLICKABLE_ROLES.has("text"), "CLICKABLE_ROLES must NOT include 'text'");
  });

  // ─── T-Connect.4 ────────────────────────────────────────────────────────────
  it("T-Connect.4: classifyOutboundLabel('Connect') returns 'connect_open' (outbound gate regression pin)", () => {
    // Given: the CONNECT_OPEN_RE matches /^Connect\b/ (verified against outboundGuard.ts:59)
    // When:  classifyOutboundLabel("Connect") is called
    // Then:  returns "connect_open" — the eventual @ovN "Connect" click is still cap-gated
    //        (regression pin proving B1 does not break outbound classification)
    const result = classifyOutboundLabel("Connect");
    assert.equal(result, "connect_open",
      `classifyOutboundLabel("Connect") must return "connect_open" (CONNECT_OPEN_RE at outboundGuard.ts:59). Got: "${result}"`);
  });
});
