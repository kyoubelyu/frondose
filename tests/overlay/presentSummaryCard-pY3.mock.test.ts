/**
 * P-Y3 Step 4a scaffold — overlay summary card renderer.
 *
 * Expected-red before Step 4b: bootstrapLegacy.ts does not define
 * window.__frondoseShowSummaryCard yet.
 *
 * Run:
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/overlay/presentSummaryCard-pY3.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import vm from "node:vm";
import { LEGACY_JS } from "../../src/overlay/bootstrapLegacy.js";

type Listener = (...args: unknown[]) => void;

class MockElement {
  readonly tagName: string;
  readonly style: { cssText: string; opacity?: string } = { cssText: "" };
  readonly children: MockElement[] = [];
  readonly attributes = new Map<string, string>();
  parentNode: MockElement | null = null;
  parentElement: MockElement | null = null;
  id = "";
  className = "";
  private text = "";
  private readonly listeners = new Map<string, Listener[]>();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  get firstChild(): MockElement | null {
    return this.children[0] ?? null;
  }

  get childElementCount(): number {
    return this.children.length;
  }

  get textContent(): string {
    return `${this.text}${this.children.map((child) => child.textContent).join("")}`;
  }

  set textContent(value: string) {
    this.text = String(value);
    this.children.length = 0;
  }

  set innerHTML(_value: string) {
    throw new Error("innerHTML must not be used by the overlay renderer");
  }

  set outerHTML(_value: string) {
    throw new Error("outerHTML must not be used by the overlay renderer");
  }

  insertAdjacentHTML(): void {
    throw new Error("insertAdjacentHTML must not be used by the overlay renderer");
  }

  appendChild(child: MockElement): MockElement {
    child.parentNode = this;
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: MockElement): MockElement {
    const idx = this.children.indexOf(child);
    if (idx >= 0) this.children.splice(idx, 1);
    child.parentNode = null;
    child.parentElement = null;
    return child;
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  closest(): MockElement | null {
    return null;
  }

  matches(): boolean {
    return false;
  }
}

function makeHarness() {
  const root = new MockElement("html");
  const body = new MockElement("body");
  const title = new MockElement("title");
  root.appendChild(body);
  const cardSlot = new MockElement("div");
  cardSlot.id = "card-slot";
  const nextActionsSlot = new MockElement("div");
  nextActionsSlot.id = "next-actions-slot";
  const retrySlot = new MockElement("div");
  const cronSlot = new MockElement("div");
  const ticker = new MockElement("div");
  const pillLabel = new MockElement("span");
  pillLabel.textContent = "Frondose";

  const context = {
    window: null as unknown,
    document: {
      documentElement: root,
      body,
      createElement: (tagName: string) => new MockElement(tagName),
      querySelector: (selector: string) => (selector === "title" ? title : null),
      addEventListener: () => undefined,
    },
    sessionStorage: {
      value: null as string | null,
      getItem: () => null,
      setItem: (_key: string, value: string) => {
        context.sessionStorage.value = value;
      },
    },
    MutationObserver: class {
      observe(): void {}
    },
    Date,
    JSON,
    clearInterval,
    clearTimeout,
    setInterval,
    setTimeout,
    addEventListener: () => undefined,
    location: { href: "https://fixture.invalid/profile", pathname: "/profile" },
    dialogExpanded: false,
    dialogElements: { cardSlot, nextActionsSlot, retrySlot, cronSlot, ticker },
    pillLabel,
    post: () => undefined,
  };
  context.window = context;
  Object.assign(context, {
    __frondoseExpandDialog: () => {
      context.dialogExpanded = true;
    },
    __frondosePost: () => undefined,
  });

  const vmContext = vm.createContext(context);
  vm.runInContext(LEGACY_JS, vmContext);
  return { context, cardSlot, nextActionsSlot };
}

function requireSummaryRenderer(context: { window?: { __frondoseShowSummaryCard?: unknown } }) {
  assert.equal(
    typeof context.window?.__frondoseShowSummaryCard,
    "function",
    "bootstrapLegacy.ts must define window.__frondoseShowSummaryCard(payloadJson)",
  );
  return context.window.__frondoseShowSummaryCard as (payloadJson: string) => void;
}

describe("bootstrapLegacy.ts — present_summary card renderer", () => {
  it("T-PY3.Overlay.1: __frondoseShowSummaryCard populates #card-slot with title, summary, bullets, and next step", () => {
    // Given: LEGACY_JS evaluated in a minimal dialog/card-slot DOM harness.
    // When: __frondoseShowSummaryCard receives a full present_summary payload.
    // Then: #card-slot is visible and contains the operator-facing summary text.
    const { context, cardSlot } = makeHarness();
    const showSummary = requireSummaryRenderer(context);

    showSummary(
      JSON.stringify({
        title: "Lead summary",
        summary: "A concise profile summary for the operator.",
        bullets: ["Owns engineering", "Canada region"],
        nextStep: "Ask before outbound.",
      }),
    );

    assert.equal(context.dialogExpanded, true, "summary renderer must expand the dialog");
    assert.match(cardSlot.style.cssText, /display:block/, "summary renderer must make #card-slot visible");
    assert.match(cardSlot.textContent, /Lead summary/);
    assert.match(cardSlot.textContent, /concise profile summary/);
    assert.match(cardSlot.textContent, /Owns engineering/);
    assert.match(cardSlot.textContent, /Canada region/);
    assert.match(cardSlot.textContent, /Ask before outbound/);
    assert.ok(cardSlot.childElementCount >= 3, "summary card should render structured child nodes");
  });

  it("T-PY3.Overlay.2: malicious-looking strings are rendered as textContent and unsafe HTML sinks stay absent", () => {
    // Given: a payload containing HTML-looking text and JavaScript-looking attributes.
    // When: __frondoseShowSummaryCard renders it.
    // Then: the literal text appears and no innerHTML/outerHTML/insertAdjacentHTML sink exists in LEGACY_JS.
    const { context, cardSlot } = makeHarness();
    const showSummary = requireSummaryRenderer(context);
    const attack = "<img src=x onerror=alert(1)>";

    showSummary(
      JSON.stringify({
        title: attack,
        summary: `Literal ${attack}`,
        bullets: [`Bullet ${attack}`],
        nextStep: `Next ${attack}`,
      }),
    );

    assert.match(cardSlot.textContent, /<img src=x onerror=alert\(1\)>/, "HTML-looking text must remain literal");
    for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML"]) {
      assert.equal(LEGACY_JS.includes(sink), false, `LEGACY_JS must not contain unsafe ${sink} sink`);
    }
  });

  it("T-PY3.Overlay.3: summary card uses #card-slot without deleting existing #next-actions-slot content", () => {
    // Given: existing next-action buttons are rendered into #next-actions-slot.
    // When: __frondoseShowSummaryCard renders a summary into #card-slot.
    // Then: the summary replaces only card-slot content; next-actions content remains intact.
    const { context, cardSlot, nextActionsSlot } = makeHarness();
    assert.equal(typeof context.window.__frondoseShowNextActions, "function", "__frondoseShowNextActions precondition");
    context.window.__frondoseShowNextActions(
      JSON.stringify({
        summary: "Existing actions",
        actions: [{ id: "a1", label: "Keep action", prompt: "Keep action prompt" }],
      }),
    );
    const beforeNextText = nextActionsSlot.textContent;
    assert.match(beforeNextText, /Keep action/, "precondition: next-actions slot has content");

    const showSummary = requireSummaryRenderer(context);
    showSummary(JSON.stringify({ title: "Summary", summary: "New card-slot content" }));

    assert.match(cardSlot.textContent, /New card-slot content/);
    assert.equal(nextActionsSlot.textContent, beforeNextText, "summary rendering must not delete next-actions slot");
  });
});
