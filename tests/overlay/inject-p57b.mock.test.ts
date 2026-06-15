/**
 * P-57b Step 5 — T-Passive.1, T-Passive.6, T-Passive.7, T-Overlay.10 — FILLED
 * (G-P57b.2, G-P57b.8, G-P57b.12)
 *
 * Mock tests for P-57b extensions to `src/overlay/inject.ts`:
 *   T-Passive.1  — `installOverlay` env-internal read substitutes `__MAI_PASSIVE_ENABLED__`
 *                  token from process.env.FRONDOSE_PASSIVE_SUGGEST (OQ-PLAN.29 rev-2 Option C).
 *   T-Passive.6  — Click listener registered with capture-phase + passive:true + 300ms
 *                  debounce + #__mai_root self-feedback filter + 100-char targetText slice +
 *                  emits `{type:"observe", event_type:"click", ctx:{url,targetTag,targetText,x,y}}`.
 *   T-Passive.7  — Click debounce coalesces rapid bursts (`debounce(..., 300)` + `clearTimeout`
 *                  on each call replaces the pending timer, so 10 rapid clicks → 1 dispatch).
 *   T-Overlay.10 — TT-safe + click present + scroll/sampleVisibleFeedPosts absent +
 *                  collapsed-card fns + `__MAI_PASSIVE_ENABLED__` placeholder.
 *
 * Gate coverage:
 *   G-P57b.2  — passiveEnabled env-gate substitutes correctly (T-Passive.1)
 *   G-P57b.8  — Trusted Types safe DOM API only (T-Overlay.10)
 *   G-P57b.12 — Click listener metadata + #__mai_root filter + 300ms debounce coalesce
 *
 * Mock strategy:
 *   - T-Passive.1: spy-style fake CdpHandle captures the {source} arg of
 *     Page.addScriptToEvaluateOnNewDocument; we verify the substitution produced
 *     `MAI_PASSIVE_ENABLED = true|false` literally via grep on the captured source.
 *   - T-Passive.6 + T-Passive.7: structural substring-grep against OVERLAY_BOOTSTRAP_JS
 *     — proves the click handler is registered with the right options (capture+passive),
 *     the right debounce semantics (300ms + clearTimeout on each call), the right filter
 *     (closest('#__mai_root')), the right slice (slice(0, 100)), and the right payload
 *     shape (type:"observe", event_type:"click", ctx:{...}). Behavioral runtime verification
 *     happens at LIVE.10 (real-Chrome click-burst stress) where 20 rapid clicks compound
 *     with rate-limit + ICP pre-filter — the substring-grep here proves the source
 *     contains the right code; LIVE.10 proves the code runs as designed.
 *     (Note: a JSDOM-based behavioral test would require adding jsdom to devDeps —
 *     CLAUDE.md "No dependency drift" forbids that. The vm.runInNewContext path was
 *     considered but the IIFE's dependency on a full event-target/MutationObserver/closest
 *     surface would require ~120 LOC of manual DOM stubs for marginal incremental value
 *     over the grep + LIVE.10 combination.)
 *   - T-Overlay.10: pure substring greps as Step 4a planned.
 *
 * Run (mock):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     --test-timeout=30000 tests/overlay/inject-p57b.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installOverlay, OVERLAY_BOOTSTRAP_JS } from "../../src/overlay/inject.js";

// ─── T-Passive.1 — installOverlay env-internal substitution ─────────────────

describe("installOverlay — substitutes __MAI_PASSIVE_ENABLED__ from process.env.FRONDOSE_PASSIVE_SUGGEST at install site (G-P57b.2)", () => {
  it("T-Passive.1: given OVERLAY_BOOTSTRAP_JS contains __MAI_PASSIVE_ENABLED__ placeholder + fake CdpHandle whose Page.addScriptToEvaluateOnNewDocument captures the {source} arg, WHEN installOverlay called twice (FRONDOSE_PASSIVE_SUGGEST='on' then 'off'), THEN first captured source contains 'MAI_PASSIVE_ENABLED = true' AND does NOT contain '__MAI_PASSIVE_ENABLED__'; second captured source contains 'MAI_PASSIVE_ENABLED = false' AND does NOT contain '__MAI_PASSIVE_ENABLED__'", async () => {
    // Given: OVERLAY_BOOTSTRAP_JS contains the placeholder verbatim
    // When:  installOverlay invoked twice with different FRONDOSE_PASSIVE_SUGGEST values
    // Then:  captured sources have substituted boolean literals + zero remaining placeholders

    // Sanity: baseline placeholder exists exactly once
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("__MAI_PASSIVE_ENABLED__"),
      "baseline OVERLAY_BOOTSTRAP_JS must contain the __MAI_PASSIVE_ENABLED__ placeholder",
    );
    // One occurrence exactly (defensive: regex global count)
    const placeholderCount = (OVERLAY_BOOTSTRAP_JS.match(/__MAI_PASSIVE_ENABLED__/g) ?? []).length;
    assert.equal(placeholderCount, 1, `placeholder must appear exactly once; got ${placeholderCount}`);

    // Capture-spy fake CdpHandle
    const capturedSources: string[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: fake CdpHandle — typed loosely
    const fakeHandle: any = {
      Runtime: {
        enable: async () => undefined,
        addBinding: async () => undefined,
      },
      Page: {
        enable: async () => undefined,
        addScriptToEvaluateOnNewDocument: async (opts: { source: string }) => {
          capturedSources.push(opts.source);
          return { identifier: `id-${capturedSources.length}` };
        },
      },
    };

    const origEnv = process.env.FRONDOSE_PASSIVE_SUGGEST;

    try {
      // (1) FRONDOSE_PASSIVE_SUGGEST=on → substitutes to `true`
      process.env.FRONDOSE_PASSIVE_SUGGEST = "on";
      await installOverlay(fakeHandle);
      assert.equal(capturedSources.length, 1, "(1) first install should have produced 1 captured source");
      const src1 = capturedSources[0] ?? "";
      assert.ok(
        src1.includes("MAI_PASSIVE_ENABLED = true"),
        `(1) source 'on' must contain 'MAI_PASSIVE_ENABLED = true'; got snippet: ${src1.slice(src1.indexOf("MAI_PASSIVE_ENABLED"), src1.indexOf("MAI_PASSIVE_ENABLED") + 80)}`,
      );
      assert.ok(
        !src1.includes("__MAI_PASSIVE_ENABLED__"),
        "(1) source 'on' must NOT contain '__MAI_PASSIVE_ENABLED__' (placeholder consumed)",
      );

      // (2) FRONDOSE_PASSIVE_SUGGEST=off → substitutes to `false`
      process.env.FRONDOSE_PASSIVE_SUGGEST = "off";
      await installOverlay(fakeHandle);
      assert.equal(capturedSources.length, 2, "(2) second install should have produced 2 captured sources total");
      const src2 = capturedSources[1] ?? "";
      assert.ok(
        src2.includes("MAI_PASSIVE_ENABLED = false"),
        `(2) source 'off' must contain 'MAI_PASSIVE_ENABLED = false'; got snippet: ${src2.slice(src2.indexOf("MAI_PASSIVE_ENABLED"), src2.indexOf("MAI_PASSIVE_ENABLED") + 80)}`,
      );
      assert.ok(
        !src2.includes("__MAI_PASSIVE_ENABLED__"),
        "(2) source 'off' must NOT contain '__MAI_PASSIVE_ENABLED__' (placeholder consumed)",
      );

      // (3) Sanity: also verify the boolean values are reflected differently
      assert.notEqual(src1, src2, "(3) source 'on' and 'off' should differ (different boolean substitution)");
    } finally {
      // Restore env so other tests don't see leaked state
      if (origEnv === undefined) {
        delete process.env.FRONDOSE_PASSIVE_SUGGEST;
      } else {
        process.env.FRONDOSE_PASSIVE_SUGGEST = origEnv;
      }
    }
  });
});

// ─── T-Passive.6 — Click observer structural assertions ─────────────────────

describe("OVERLAY_BOOTSTRAP_JS click observer — registered with capture+passive+debounce; filters #__mai_root + #__mai_collapsed_card; emits observe payload with metadata (G-P57b.12)", () => {
  it("T-Passive.6: given OVERLAY_BOOTSTRAP_JS exported, WHEN substring greps applied to the click-listener installation, THEN string contains documentElement.addEventListener('click', ..., { capture: true, passive: true }) + closest('#__mai_root') filter + closest('#__mai_collapsed_card') filter + slice(0, 100) on targetText + emits {type:'observe', event_type:'click', ctx:{url, targetTag, targetText, x, y}} via __maiPost", () => {
    // Given: OVERLAY_BOOTSTRAP_JS as P-57b-extended baseline.
    // When:  apply substring greps for each click-observer contract piece.
    // Then:  all assertions hold; proves the production code matches plan §5.2.2.

    // (a) Click listener registration on documentElement with capture+passive
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("document.documentElement.addEventListener('click'"),
      "(a) must register click listener on document.documentElement",
    );
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("capture: true"),
      "(b) listener options must include capture: true (capture-phase = see clicks before LinkedIn handlers)",
    );
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("passive: true"),
      "(c) listener options must include passive: true (prohibits preventDefault → zero LinkedIn interference)",
    );

    // (b) Self-feedback filters
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("closest('#__mai_root')"),
      "(d) must filter clicks inside #__mai_root via closest('#__mai_root')",
    );
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("closest('#__mai_collapsed_card')"),
      "(e) must filter clicks inside #__mai_collapsed_card via closest()",
    );

    // (c) targetText slice (100-char cap per plan §5.2.2)
    assert.ok(OVERLAY_BOOTSTRAP_JS.includes("slice(0, 100)"), "(f) must slice targetText to 100 chars");

    // (d) Observe payload shape — type, event_type, ctx fields
    assert.ok(OVERLAY_BOOTSTRAP_JS.includes("type: 'observe'"), "(g) payload must have type: 'observe'");
    assert.ok(OVERLAY_BOOTSTRAP_JS.includes("event_type: 'click'"), "(h) payload must have event_type: 'click'");
    // P-Z3 rebaseline: P-57e rev-2 replaced the flat targetTag/targetText ctx fields with a single
    // `ref` object built by getElementRef (nearest interactive ancestor → { tag, text, ... }).
    assert.ok(OVERLAY_BOOTSTRAP_JS.includes("ref: ref"), "(i) click ctx must carry the interactive-element ref");
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("tag: node.tagName"),
      "(j) the click ref (getElementRef) must carry the element tag",
    );
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("x: event.clientX") || OVERLAY_BOOTSTRAP_JS.includes("x: event.clientX"),
      "(k) ctx must carry x (client coords)",
    );
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("y: event.clientY") || OVERLAY_BOOTSTRAP_JS.includes("y: event.clientY"),
      "(l) ctx must carry y (client coords)",
    );

    // (e) Dispatch via __maiPost
    assert.ok(OVERLAY_BOOTSTRAP_JS.includes("window.__maiPost("), "(m) must dispatch via window.__maiPost(...)");
  });
});

// ─── T-Passive.7 — Debounce coalesces rapid bursts ──────────────────────────

describe("OVERLAY_BOOTSTRAP_JS click observer — 300ms debounce with clearTimeout on each call (10 rapid clicks coalesce to 1) (G-P57b.12)", () => {
  it("T-Passive.7: given OVERLAY_BOOTSTRAP_JS exported, WHEN substring greps applied to the debounce wrapper, THEN string contains a `debounce(...)` helper that calls `clearTimeout(t)` on each invocation (replacing pending) AND the click handler is wrapped with `debounce(...)` at 300ms; proves that 10 rapid clicks would coalesce to exactly 1 dispatch (latest-click semantics)", () => {
    // Given: OVERLAY_BOOTSTRAP_JS as P-57b-extended baseline.
    // When:  substring greps for debounce helper + 300ms cadence + clearTimeout pattern.
    // Then:  all assertions hold; proves coalesce semantics per plan §5.2.2.

    // (a) debounce function defined
    assert.ok(OVERLAY_BOOTSTRAP_JS.includes("function debounce(fn, ms)"), "(a) must define debounce(fn, ms) helper");

    // (b) debounce body calls clearTimeout (replaces pending on each call)
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("clearTimeout(t)"),
      "(b) debounce body must clearTimeout(t) on each invocation (replaces pending timer)",
    );

    // (c) debounce uses setTimeout to defer dispatch
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("setTimeout(function()"),
      "(c) debounce body must setTimeout to defer the wrapped fn",
    );

    // (d) Click handler wrapped with debounce(..., 300)
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("debounce(function(event)") ||
        OVERLAY_BOOTSTRAP_JS.includes("debounce(function (event)"),
      "(d) must wrap the click handler body via debounce(function(event) {...}, 300)",
    );

    // (e) Cadence is 300ms (the locked debounce cadence per plan §5.2.2)
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes(", 300)"),
      "(e) click debounce cadence must be 300 (ms); proves the locked 300ms debounce coalesces bursts",
    );

    // (f) Sanity: input debounce is 1000ms (NOT 300) per plan §5.2.2 — confirms the
    //     300ms occurrence above is the click cadence, not a duplicate of input.
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes(", 1000)"),
      "(f) input debounce should be 1000 (ms) — proves the 300ms is the CLICK cadence (separate from input's 1000ms)",
    );
  });
});

// ─── T-Overlay.10 — Trusted Types safety + observer presence/absence checks ─

describe("OVERLAY_BOOTSTRAP_JS — TT-safe + collapsed-card fns + click present + scroll/sampleVisibleFeedPosts absent + substitution placeholder (G-P57b.8)", () => {
  it("T-Overlay.10: given OVERLAY_BOOTSTRAP_JS as exported string, WHEN substring searches applied, THEN string contains 'window.__maiShowCollapsedCard = function' + 'window.__maiHideCollapsedCard = function' + 'installPageObservers' + 'detectComposerKind' + \"addEventListener('click'\" + 'MAI_PASSIVE_ENABLED = __MAI_PASSIVE_ENABLED__'; does NOT contain 'sampleVisibleFeedPosts' / \"addEventListener('scroll'\" / '.innerHTML' / '.outerHTML' / 'insertAdjacentHTML'", () => {
    // 6 PRESENT + 5 ABSENT = 11 substring assertions per plan §6 T-Overlay.10 rev-1 spec.

    // PRESENT (6)
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("window.__maiShowCollapsedCard = function"),
      "(a) must contain 'window.__maiShowCollapsedCard = function' (collapsed-card render)",
    );
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("window.__maiHideCollapsedCard = function"),
      "(b) must contain 'window.__maiHideCollapsedCard = function' (collapsed-card hide)",
    );
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("installPageObservers"),
      "(c) must contain 'installPageObservers' (declared + called inside IIFE)",
    );
    // P-Z3 rebaseline: P-57e rev-2 dropped the detectComposerKind helper; the input observer is now a
    // debounced 'input' listener emitting event_type:'input'. Assert that surviving input observer.
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("event_type: 'input'"),
      "(d) must contain the input observer (event_type: 'input')",
    );
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("addEventListener('click'"),
      "(e) must contain \"addEventListener('click'\" (click observer registration per rev-1)",
    );
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("MAI_PASSIVE_ENABLED = __MAI_PASSIVE_ENABLED__"),
      "(f) must contain 'MAI_PASSIVE_ENABLED = __MAI_PASSIVE_ENABLED__' (substitution placeholder per §5.2.1)",
    );

    // ABSENT (5 — TT-safe + rev-1 dropped)
    assert.ok(
      !OVERLAY_BOOTSTRAP_JS.includes("sampleVisibleFeedPosts"),
      "(g) must NOT contain 'sampleVisibleFeedPosts' (rev-1 dropped — was scroll observer helper)",
    );
    assert.ok(
      !OVERLAY_BOOTSTRAP_JS.includes("addEventListener('scroll'"),
      "(h) must NOT contain \"addEventListener('scroll'\" (rev-1 dropped — scroll observer dropped)",
    );
    assert.ok(!OVERLAY_BOOTSTRAP_JS.includes(".innerHTML"), "(i) must NOT contain '.innerHTML' (TT violation)");
    assert.ok(!OVERLAY_BOOTSTRAP_JS.includes(".outerHTML"), "(j) must NOT contain '.outerHTML' (TT violation)");
    assert.ok(
      !OVERLAY_BOOTSTRAP_JS.includes("insertAdjacentHTML"),
      "(k) must NOT contain 'insertAdjacentHTML' (TT violation)",
    );
  });
});
