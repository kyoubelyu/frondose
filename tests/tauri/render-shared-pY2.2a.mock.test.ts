/**
 * P-Y2.2a Step 4a — T-Shared.1/.2/.3 — SCAFFOLD (assertion bodies = TODO; intentionally RED).
 *
 * Pure-unit tests for the additive shared-render changes (plan §6.4-J): the new `buildLeafMark(doc)`
 * (inline brand SVG from `LEAF_SVG` — the overlay needs inline SVG since an <img src> 404s in-page, F6)
 * and the new optional `compact` flag on `buildAutoStage` (hover-Auto drops the full timeline). Both must
 * be backward-compatible — the desktop 2-arg call site is unaffected.
 *
 * LOAD: LOADS NOW (namespace import — render.js exists). `buildLeafMark` + the `compact` flag do NOT exist
 * until builder 4b; a NAMED static import of `buildLeafMark` would crash the load ("does not provide an
 * export named …"), so render is imported as a NAMESPACE — `render.buildLeafMark` is `undefined` until 4b
 * and every body is `assert.fail("TODO Step 5: …")`. Step 5 fills against `render.buildLeafMark` /
 * `render.buildAutoStage(doc, wf, { compact })` using the recording DocumentLike stub below.
 *
 * Gate coverage: G-PY2.2a.5 (render.ts additive: buildLeafMark; buildAutoStage compact drops timeline;
 *   desktop default unaffected).
 *
 * Run (mock): node --import tsx --test --test-force-exit --test-timeout=30000 \
 *   tests/tauri/render-shared-pY2.2a.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LEAF_SVG } from "../../src/tauri/ui/frondoseTokens.js";
import * as render from "../../src/tauri/ui/render.js";

const SVG_NS = "http://www.w3.org/2000/svg";

// ─── Recording DocumentLike stub (createElement/createElementNS/getElementById tracked) ──────────────
interface RecEl {
  tag: string;
  ns: string | null;
  attrs: Record<string, string>;
  classes: Set<string>;
  children: RecEl[];
  textContent: string | null;
  id?: string;
  innerHTMLSet: boolean;
}
function makeRecEl(tag: string, ns: string | null): RecEl {
  const el: RecEl = { tag, ns, attrs: {}, classes: new Set(), children: [], textContent: null, innerHTMLSet: false };
  return el;
}
/** A DocumentLike whose create/getElementById return recording elements; tracks all created nodes. */
function makeRecDoc(seedById: Record<string, RecEl> = {}) {
  const created: RecEl[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: the stub is shaped to satisfy render.ts's DocumentLike/ElementLike at Step 5.
  const wrap = (el: RecEl): any => ({
    tagName: el.tag,
    get textContent() {
      return el.textContent;
    },
    set textContent(v: string | null) {
      el.textContent = v;
    },
    set innerHTML(_v: string) {
      el.innerHTMLSet = true;
    },
    classList: {
      add: (c: string) => void el.classes.add(c),
      remove: (c: string) => void el.classes.delete(c),
      toggle: (c: string, f?: boolean) => void ((f ?? !el.classes.has(c)) ? el.classes.add(c) : el.classes.delete(c)),
      contains: (c: string) => el.classes.has(c),
    },
    setAttribute: (k: string, v: string) => {
      el.attrs[k] = v;
    },
    getAttribute: (k: string) => el.attrs[k] ?? null,
    appendChild: (c: { __rec: RecEl }) => {
      el.children.push(c.__rec);
      return c;
    },
    __rec: el,
  });
  const doc = {
    createElement: (tag: string) => {
      const el = makeRecEl(tag, null);
      created.push(el);
      return wrap(el);
    },
    createElementNS: (ns: string, tag: string) => {
      const el = makeRecEl(tag, ns);
      created.push(el);
      return wrap(el);
    },
    getElementById: (id: string) => {
      const el = seedById[id];
      return el ? wrap(el) : null;
    },
  };
  return { doc, created, seedById };
}

describe("render.buildLeafMark — builds an inline SVG from LEAF_SVG (G-PY2.2a.5)", () => {
  // Given: a recording DocumentLike stub.
  // When:  render.buildLeafMark(stub.doc) runs.
  // Then:  one <svg> created via createElementNS (NS http://www.w3.org/2000/svg) with viewBox===LEAF_SVG.viewBox,
  //        LEAF_SVG.paths.length <path> children each with a "d" attr from LEAF_SVG.paths; innerHTML never set.
  it("T-Shared.1: buildLeafMark creates one NS svg (viewBox=LEAF_SVG.viewBox) with LEAF_SVG.paths.length <path> children (each with a 'd' attr), never using innerHTML", () => {
    const { doc, created } = makeRecDoc();
    const buildLeafMark = (render as { buildLeafMark?: (d: unknown) => unknown }).buildLeafMark;
    assert.equal(typeof buildLeafMark, "function", "render.ts must export buildLeafMark (builder 4b)");
    buildLeafMark?.(doc);
    const svgs = created.filter((e) => e.tag === "svg");
    assert.equal(svgs.length, 1, "exactly one <svg> created");
    assert.equal(svgs[0]?.ns, SVG_NS, "svg created via createElementNS (SVG namespace) — inline SVG, not <img>");
    assert.equal(svgs[0]?.attrs.viewBox, LEAF_SVG.viewBox, "svg viewBox === LEAF_SVG.viewBox");
    const paths = created.filter((e) => e.tag === "path");
    assert.equal(paths.length, LEAF_SVG.paths.length, `one <path> per LEAF_SVG path (${LEAF_SVG.paths.length})`);
    for (const p of paths)
      assert.ok(typeof p.attrs.d === "string" && p.attrs.d.length > 0, "each path has a non-empty 'd' attr");
    assert.deepEqual(
      paths.map((p) => p.attrs.d).sort(),
      [...LEAF_SVG.paths].sort(),
      "path 'd' attrs come from LEAF_SVG.paths",
    );
    assert.ok(
      created.every((e) => !e.innerHTMLSet),
      "buildLeafMark must never use innerHTML (TT-safe)",
    );
  });
});

describe("render.buildAutoStage — compact omits the timeline (G-PY2.2a.5)", () => {
  // Given: a recording stub seeding an #auto-stage element + a mock WorkflowLike with 7 steps.
  // When:  render.buildAutoStage(doc, wf, { compact: true }) runs.
  // Then:  the #auto-stage subtree has a hero + a progress-strip but NO timeline; AND with { compact:false }
  //        (or no opts) it DOES contain a timeline (desktop behavior unchanged).
  it("T-Shared.2: buildAutoStage(doc, wf, { compact:true }) builds hero + progress-strip but NO timeline; { compact:false } includes a timeline", () => {
    const wf = makeWorkflow();
    // compact: true → no timeline
    const stageC = makeRecEl("section", null);
    const recC = makeRecDoc({ "auto-stage": stageC });
    render.buildAutoStage(recC.doc as never, wf as never, { compact: true });
    const childClassesC = stageC.children.map((c) => [...c.classes]);
    assert.ok(
      childClassesC.some((cl) => cl.includes("hero")),
      "compact must include a hero",
    );
    assert.ok(
      childClassesC.some((cl) => cl.includes("progress-strip")),
      "compact must include a progress-strip",
    );
    assert.ok(
      !childClassesC.some((cl) => cl.includes("timeline")),
      `compact must OMIT the timeline; got ${JSON.stringify(childClassesC)}`,
    );
    // compact: false → timeline present
    const stageF = makeRecEl("section", null);
    const recF = makeRecDoc({ "auto-stage": stageF });
    render.buildAutoStage(recF.doc as never, wf as never, { compact: false });
    assert.ok(
      stageF.children.map((c) => [...c.classes]).some((cl) => cl.includes("timeline")),
      "compact:false must include the timeline",
    );
  });
});

describe("render.buildAutoStage — desktop 2-arg call unchanged (G-PY2.2a.5)", () => {
  // Given: the 2-arg call buildAutoStage(doc, wf) (no opts).  When: run.
  // Then: behaves exactly as before this phase — hero + progress-strip + timeline (compact defaults falsy).
  it("T-Shared.3: the 2-arg buildAutoStage(doc, wf) (desktop call) still builds hero + progress-strip + timeline (compact defaults falsy — no desktop regression)", () => {
    const wf = makeWorkflow();
    const stage = makeRecEl("section", null);
    const rec = makeRecDoc({ "auto-stage": stage });
    render.buildAutoStage(rec.doc as never, wf as never); // 2-arg desktop call
    const childClasses = stage.children.map((c) => [...c.classes]);
    assert.ok(
      childClasses.some((cl) => cl.includes("hero")),
      "desktop default must include a hero",
    );
    assert.ok(
      childClasses.some((cl) => cl.includes("progress-strip")),
      "desktop default must include a progress-strip",
    );
    assert.ok(
      childClasses.some((cl) => cl.includes("timeline")),
      "desktop default (no opts) must include the timeline (compact defaults falsy — no regression)",
    );
  });
});

/** A mock WorkflowLike (render.ts:66-73 shape) with 7 steps — enough for hero/strip/timeline. */
function makeWorkflow() {
  const st = (id: string, state: string, requiresApproval = false) => ({ id, title: id, state, requiresApproval });
  return {
    workflowId: "wf-demo",
    title: "Bulk outreach add",
    approvalMode: "manual",
    pendingStepId: "s3",
    notice: "Approval required.",
    steps: [
      st("s1", "completed"),
      st("s2", "completed"),
      st("s3", "pending", true),
      st("s4", "in_progress"),
      st("s5", "pending"),
      st("s6", "pending"),
      st("s7", "pending"),
    ],
  };
}

void [makeRecDoc, SVG_NS, LEAF_SVG, render];
