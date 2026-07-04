/**
 * T-FE-CHAT bug 1 — mock tests for the safe markdown->DOM renderer
 * (src/tauri/ui/render/markdown.ts, re-exported via src/tauri/ui/render.ts).
 *
 * Imports go through the BARREL (../../../src/tauri/ui/render.js), never a leaf path directly —
 * tests/tauri/ui/render-split-slice12.mock.test.ts (R-Source.2) asserts repo-wide that no test
 * imports `.../tauri/ui/render/<leaf>` directly.
 *
 * A minimal recording fake for DocumentLike/ElementLike (createElement/classList/textContent/
 * appendChild/setAttribute/getAttribute) — no innerHTML anywhere in the fake or the module under
 * test; the fake exists purely to inspect the tree the safe DOM builder produced.
 *
 * Run:
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tauri/ui/markdownRenderer-tfeChat.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildMarkdownNodes, renderMarkdownInto } from "../../../src/tauri/ui/render.js";

interface FakeEl {
  tag: string;
  classes: Set<string>;
  attrs: Record<string, string>;
  children: FakeEl[];
  text: string | null;
}

function makeFakeEl(tag: string): FakeEl {
  return { tag, classes: new Set(), attrs: {}, children: [], text: null };
}

// biome-ignore lint/suspicious/noExplicitAny: test stub shaped to satisfy DocumentLike/ElementLike
function wrap(fe: FakeEl): any {
  return {
    _fe: fe,
    get textContent() {
      return fe.text;
    },
    set textContent(v: string | null) {
      fe.text = v;
      fe.children = []; // matches real DOM: assigning textContent clears prior children
    },
    classList: {
      add: (c: string) => void fe.classes.add(c),
      remove: (c: string) => void fe.classes.delete(c),
      toggle: (c: string, force?: boolean) => {
        const on = force ?? !fe.classes.has(c);
        if (on) fe.classes.add(c);
        else fe.classes.delete(c);
      },
    },
    setAttribute: (k: string, v: string) => {
      fe.attrs[k] = v;
    },
    getAttribute: (k: string) => fe.attrs[k] ?? null,
    appendChild: (child: { _fe: FakeEl }) => {
      fe.children.push(child._fe);
      return child;
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: test stub shaped to satisfy DocumentLike
function makeFakeDoc(): any {
  return {
    documentElement: wrap(makeFakeEl("html")),
    getElementById: () => null,
    createElement: (tag: string) => wrap(makeFakeEl(tag)),
    createElementNS: (_ns: string, tag: string) => wrap(makeFakeEl(tag)),
  };
}

function flattenText(fe: FakeEl): string {
  if (fe.children.length === 0) return fe.text ?? "";
  return fe.children.map(flattenText).join("");
}

function findAll(fe: FakeEl, tag: string): FakeEl[] {
  const hits: FakeEl[] = [];
  if (fe.tag === tag) hits.push(fe);
  for (const c of fe.children) hits.push(...findAll(c, tag));
  return hits;
}

// biome-ignore lint/suspicious/noExplicitAny: nodes are the module's ElementLike (structurally our FakeEl wrap)
function nodesToFe(nodes: any[]): FakeEl[] {
  return nodes.map((n) => n._fe as FakeEl);
}

describe("buildMarkdownNodes — XSS/safety (BLOCKER coverage)", () => {
  it("T-MdSafe.1: a literal <script> payload never becomes a script element; it renders as inert text", () => {
    // Given: assistant text containing a raw <script> tag (untrusted model output)
    // When:  buildMarkdownNodes parses it
    // Then:  no "script" element anywhere in the tree; the literal text survives as textContent
    const doc = makeFakeDoc();
    const nodes = nodesToFe(buildMarkdownNodes(doc, 'before <script>alert(1)</script> after'));
    for (const top of nodes) {
      assert.equal(findAll(top, "script").length, 0, "no <script> element must ever be built");
    }
    const all = nodes.map(flattenText).join("\n");
    assert.ok(all.includes("<script>alert(1)</script>"), "the raw tag text must survive as inert text");
  });

  it("T-MdSafe.2: javascript: and data: link targets are downgraded to plain text (never an href)", () => {
    // Given: explicit markdown links using unsafe schemes
    // When:  buildMarkdownNodes parses them
    // Then:  no <a> element is built for either; no element's href attribute contains the unsafe URL
    const doc = makeFakeDoc();
    const nodes = nodesToFe(
      buildMarkdownNodes(doc, "[click me](javascript:alert(1)) and [x](data:text/html,<b>hi</b>)"),
    );
    for (const top of nodes) {
      const anchors = findAll(top, "a");
      for (const a of anchors) {
        assert.ok(!("href" in a.attrs), `no <a> may carry an href for an unsafe scheme; got ${JSON.stringify(a.attrs)}`);
      }
    }
  });

  it("T-MdSafe.3: safe http/https/mailto links become <a rel=noopener noreferrer target=_blank>", () => {
    // Given: an https link, a mailto link, and a bare http URL
    // When:  buildMarkdownNodes parses them
    // Then:  each becomes a real <a> with the safe href + rel/target attributes set
    const doc = makeFakeDoc();
    const nodes = nodesToFe(
      buildMarkdownNodes(
        doc,
        "[docs](https://example.com/a) and [mail](mailto:x@example.com) and bare http://example.org/y",
      ),
    );
    const anchors = nodes.flatMap((n) => findAll(n, "a"));
    assert.equal(anchors.length, 3, `expected 3 anchors; got ${anchors.length}`);
    const hrefs = anchors.map((a) => a.attrs.href).sort();
    assert.deepEqual(hrefs, ["http://example.org/y", "https://example.com/a", "mailto:x@example.com"].sort());
    for (const a of anchors) {
      assert.equal(a.attrs.rel, "noopener noreferrer");
      assert.equal(a.attrs.target, "_blank");
    }
  });

  it("T-MdSafe.4: a control-char/whitespace-obfuscated javascript: scheme is still rejected", () => {
    // Given: "java\tscript:alert(1)" and "  javascript:alert(1)" (disguised via tab / leading spaces)
    // When:  buildMarkdownNodes parses an explicit link using each as the URL
    // Then:  neither becomes an <a> with an href (the obfuscation must not bypass the scheme check)
    const doc = makeFakeDoc();
    const nodes = nodesToFe(
      buildMarkdownNodes(doc, "[a](java\tscript:alert(1)) and [b](  javascript:alert(1))"),
    );
    for (const top of nodes) {
      const anchors = findAll(top, "a");
      for (const a of anchors) {
        assert.ok(!("href" in a.attrs), `obfuscated javascript: must not reach an href; got ${JSON.stringify(a.attrs)}`);
      }
    }
  });
});

describe("buildMarkdownNodes — XSS/safety, validator-added adversarial cases (T-FE-CHAT Step 5)", () => {
  it("T-MdSafe.5: a mixed-case JavaScript: scheme is rejected the same as lowercase javascript:", () => {
    // Given: an explicit link whose scheme is cased "JavaScript:" (a naive case-sensitive
    //        scheme-allowlist check could be bypassed this way)
    // When:  buildMarkdownNodes parses it
    // Then:  no <a> element carries an href; the case-insensitive scheme check rejects it
    const doc = makeFakeDoc();
    const nodes = nodesToFe(buildMarkdownNodes(doc, "[x](JavaScript:alert(1))"));
    for (const top of nodes) {
      for (const a of findAll(top, "a")) {
        assert.ok(!("href" in a.attrs), `mixed-case JavaScript: must not reach an href; got ${JSON.stringify(a.attrs)}`);
      }
    }
    assert.ok(flattenText(nodes[0] as FakeEl).includes("JavaScript:alert"), "the literal text must survive inertly");
  });

  it("T-MdSafe.6: a vbscript: link target is rejected (not on the http/https/mailto allowlist)", () => {
    // Given: an explicit link using the legacy vbscript: scheme
    // When:  buildMarkdownNodes parses it
    // Then:  no <a> element carries an href
    const doc = makeFakeDoc();
    const nodes = nodesToFe(buildMarkdownNodes(doc, "[x](vbscript:alert(1))"));
    for (const top of nodes) {
      for (const a of findAll(top, "a")) {
        assert.ok(!("href" in a.attrs), `vbscript: must not reach an href; got ${JSON.stringify(a.attrs)}`);
      }
    }
  });

  it("T-MdSafe.7: a bare (non-markdown-link) javascript: URL in plain text is never turned into a link", () => {
    // Given: plain text containing "javascript:alert(1)" with no [label](...) syntax around it
    // When:  buildMarkdownNodes parses it
    // Then:  the bare-URL auto-link path only matches http(s):// — no <a> is built, text survives
    const doc = makeFakeDoc();
    const nodes = nodesToFe(buildMarkdownNodes(doc, "plain javascript:alert(1) text"));
    for (const top of nodes) assert.equal(findAll(top, "a").length, 0, "a bare javascript: URL must never auto-link");
    assert.ok(flattenText(nodes[0] as FakeEl).includes("javascript:alert(1)"));
  });

  it("T-MdSafe.8: a non-whitespace control character embedded in a scheme (obfuscation) is still rejected", () => {
    // Given: "java<0x01>script:alert(1)" — a control byte that is NOT whitespace (so it is not
    //        excluded by the inline-link regex's `[^)\s]+` URL matcher the way a tab/space is)
    // When:  buildMarkdownNodes parses an explicit link using it as the URL
    // Then:  normalizeUrl strips the control byte before scheme-sniffing, so the reassembled
    //        scheme ("javascript") is still caught and rejected — no href is ever set
    const doc = makeFakeDoc();
    const nodes = nodesToFe(buildMarkdownNodes(doc, `[x](java${String.fromCharCode(1)}script:alert(1))`));
    for (const top of nodes) {
      for (const a of findAll(top, "a")) {
        assert.ok(!("href" in a.attrs), `control-char-obfuscated javascript: must not reach an href; got ${JSON.stringify(a.attrs)}`);
      }
    }
  });

  it("T-MdSafe.9: a raw <img onerror> / <a onclick> HTML payload never becomes a real element; text survives", () => {
    // Given: assistant text containing raw HTML with an inline event-handler attribute
    // When:  buildMarkdownNodes parses it (the module never parses HTML — no DOMParser/innerHTML)
    // Then:  no img/a/script element is built for either payload; the literal text is preserved
    const doc = makeFakeDoc();
    const imgNodes = nodesToFe(buildMarkdownNodes(doc, "before <img src=x onerror=alert(1)> after"));
    for (const top of imgNodes) assert.equal(findAll(top, "img").length, 0, "no <img> element must ever be built");
    assert.ok(flattenText(imgNodes[0] as FakeEl).includes("<img src=x onerror=alert(1)>"));

    const doc2 = makeFakeDoc();
    const anchorNodes = nodesToFe(buildMarkdownNodes(doc2, "before <a href onclick=alert(1)>click</a> after"));
    // The literal "<a ...>" text must survive as inert text, not become a real anchor with onclick.
    for (const top of anchorNodes) {
      for (const a of findAll(top, "a")) {
        assert.ok(!("onclick" in a.attrs), "no <a> may ever carry an onclick attribute");
      }
    }
    assert.ok(flattenText(anchorNodes[0] as FakeEl).includes("<a href onclick=alert(1)>click</a>"));
  });

  it("T-MdSafe.10: a link-syntax attempt spanning an embedded raw newline never forms a link or drops the text", () => {
    // Given: "[x](java\nscript:alert(1))" — the closing paren is on a different line from the
    //        opening; the inline URL matcher excludes \s (incl. \n), so no cross-line link can form
    // When:  buildMarkdownNodes parses it (block splitting joins the two lines into one paragraph
    //        with a single space, per the module's documented streaming-paragraph behavior)
    // Then:  no <a> element is built anywhere, and the visible text (mod newline->space) survives
    const doc = makeFakeDoc();
    const nodes = nodesToFe(buildMarkdownNodes(doc, "[x](java\nscript:alert(1))"));
    for (const top of nodes) assert.equal(findAll(top, "a").length, 0, "a newline-split link attempt must never form an <a>");
    const all = nodes.map(flattenText).join("\n");
    assert.ok(all.includes("java") && all.includes("script:alert(1)"), "the text must survive, not be dropped");
  });
});

describe("buildMarkdownNodes — block/inline coverage (§5 requirements)", () => {
  it("T-MdBasic.1: **bold** and *italic* render as classed spans, not literal asterisks", () => {
    const doc = makeFakeDoc();
    const [p] = nodesToFe(buildMarkdownNodes(doc, "a **bold** and *italic* word"));
    assert.equal(p.tag, "p");
    const bold = findAll(p, "span").filter((s) => s.classes.has("md-bold"));
    const italic = findAll(p, "span").filter((s) => s.classes.has("md-italic"));
    assert.equal(bold.length, 1);
    assert.equal(bold[0]?.text, "bold");
    assert.equal(italic.length, 1);
    assert.equal(italic[0]?.text, "italic");
  });

  it("T-MdBasic.2: inline `code` and a fenced code block both render via <code>, without inline-parsing the code content", () => {
    const doc = makeFakeDoc();
    const nodes = nodesToFe(buildMarkdownNodes(doc, "inline `**not bold**` here\n\n```\nline1\n**also not bold**\n```"));
    const p = nodes.find((n) => n.tag === "p");
    assert.ok(p, "expected a paragraph for the inline-code line");
    const inlineCode = findAll(p as FakeEl, "code");
    assert.equal(inlineCode.length, 1);
    assert.equal(inlineCode[0]?.text, "**not bold**", "inline code content must not be re-parsed as markdown");

    const pre = nodes.find((n) => n.tag === "pre");
    assert.ok(pre, "expected a <pre> for the fenced code block");
    const blockCode = findAll(pre as FakeEl, "code");
    assert.equal(blockCode.length, 1);
    assert.equal(blockCode[0]?.text, "line1\n**also not bold**");
  });

  it("T-MdBasic.3: unordered (-) and ordered (1.) lists render as <ul>/<ol> with one <li> per item", () => {
    const doc = makeFakeDoc();
    const [ul] = nodesToFe(buildMarkdownNodes(doc, "- one\n- two\n- three"));
    assert.equal(ul.tag, "ul");
    assert.equal(ul.children.filter((c) => c.tag === "li").length, 3);
    assert.equal(flattenText(ul.children[0] as FakeEl), "one");

    const doc2 = makeFakeDoc();
    const [ol] = nodesToFe(buildMarkdownNodes(doc2, "1. first\n2. second"));
    assert.equal(ol.tag, "ol");
    assert.equal(ol.children.filter((c) => c.tag === "li").length, 2);
  });

  it("T-MdBasic.4: ATX headings (#, ##, ######) render as h1..h6", () => {
    const doc = makeFakeDoc();
    const nodes = nodesToFe(buildMarkdownNodes(doc, "# One\n\n## Two\n\n###### Six"));
    assert.deepEqual(nodes.map((n) => n.tag), ["h1", "h2", "h6"]);
    assert.equal(flattenText(nodes[0] as FakeEl), "One");
  });

  it("T-MdBasic.5: a valid pipe table (header + --- separator + body) renders as a real <table>", () => {
    const doc = makeFakeDoc();
    const [table] = nodesToFe(buildMarkdownNodes(doc, "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |"));
    assert.equal(table.tag, "table");
    const ths = findAll(table, "th");
    assert.deepEqual(ths.map(flattenText), ["A", "B"]);
    const trs = findAll(findAll(table, "tbody")[0] as FakeEl, "tr");
    assert.equal(trs.length, 2);
    assert.deepEqual(findAll(trs[0] as FakeEl, "td").map(flattenText), ["1", "2"]);
  });

  it("T-MdBasic.6: a table cell containing markup-looking text (**bold**) still renders safely via inline parse", () => {
    const doc = makeFakeDoc();
    const [table] = nodesToFe(buildMarkdownNodes(doc, "| A |\n| --- |\n| **bold** cell |"));
    assert.equal(table.tag, "table");
    const td = findAll(table, "td")[0];
    assert.ok(td, "expected one td");
    assert.equal(findAll(td as FakeEl, "span").filter((s) => s.classes.has("md-bold")).length, 1);
    assert.equal(flattenText(td as FakeEl), "bold cell");
  });
});

describe("buildMarkdownNodes — incremental/streaming degradation (CONCERN-MR coverage)", () => {
  it("T-MdStream.1: an unterminated fenced code block (no closing ```) is treated as code through the end of the buffer, never dropped", () => {
    const doc = makeFakeDoc();
    const nodes = nodesToFe(buildMarkdownNodes(doc, "text before\n\n```\nstill streaming\nmore code lines"));
    const pre = nodes.find((n) => n.tag === "pre");
    assert.ok(pre, "an open fence must still produce a code block");
    const code = findAll(pre as FakeEl, "code")[0];
    assert.equal(code?.text, "still streaming\nmore code lines");
  });

  it("T-MdStream.2: a pipe line with no valid separator row (yet) falls back to a plain paragraph, not a table", () => {
    const doc = makeFakeDoc();
    const nodes = nodesToFe(buildMarkdownNodes(doc, "| A | B |\nnot a separator line"));
    assert.equal(
      nodes.some((n) => n.tag === "table"),
      false,
      "an invalid/partial pipe block must never be promoted to <table>",
    );
    assert.ok(nodes.some((n) => n.tag === "p"), "the pipe line must fall back to a paragraph");
  });

  it("T-MdStream.3: unclosed emphasis (a lone opening ** with no closing pair) renders as literal text, not swallowed", () => {
    const doc = makeFakeDoc();
    const [p] = nodesToFe(buildMarkdownNodes(doc, "Hello **world, still typing"));
    assert.equal(flattenText(p), "Hello **world, still typing");
  });

  it("T-MdStream.4: trailing partial text (buffer ends mid-sentence, no trailing newline) is never dropped", () => {
    const doc = makeFakeDoc();
    const nodes = nodesToFe(buildMarkdownNodes(doc, "First paragraph.\n\nSecond is still comin"));
    const all = nodes.map(flattenText).join("\n");
    assert.ok(all.includes("Second is still comin"), "trailing partial text must survive re-render");
  });
});

describe("renderMarkdownInto — one-pass container replace", () => {
  it("T-MdRender.1: renderMarkdownInto clears prior children and appends the freshly parsed tree", () => {
    const doc = makeFakeDoc();
    const container = wrap(makeFakeEl("div"));
    renderMarkdownInto(doc, container, "first pass **bold**");
    assert.equal(findAll(container._fe as FakeEl, "span").filter((s) => s.classes.has("md-bold")).length, 1);

    // Re-render with different (shorter) content — the OLD children must not linger.
    renderMarkdownInto(doc, container, "second pass, no bold");
    assert.equal(
      findAll(container._fe as FakeEl, "span").filter((s) => s.classes.has("md-bold")).length,
      0,
      "a re-render must fully replace prior children, not append onto them",
    );
    assert.ok(flattenText(container._fe as FakeEl).includes("second pass"));
  });
});
