/**
 * P-8 mock tests — T-Markdown.1..T-Markdown.12
 *
 * Tests for renderMarkdown() in src/cli/markdown.ts.
 *
 * In the test environment chalk level = 0 (no color output), so we test
 * structural markers and text content rather than ANSI codes.
 *
 * T-Markdown.1  — fenced code block → ╭─ / │ / ╰─ structural markers
 * T-Markdown.2  — h1 header text present
 * T-Markdown.3  — h2/h3 headers present
 * T-Markdown.4  — blockquote → │ prefix
 * T-Markdown.5  — unordered list → • prefix
 * T-Markdown.6  — ordered list → number preserved
 * T-Markdown.7  — table separator row rendered (dimmed = plain in test env)
 * T-Markdown.8  — inline code text visible
 * T-Markdown.9  — bold text content visible
 * T-Markdown.10 — italic text content visible
 * T-Markdown.11 — CJK text passes through unchanged (multi-byte safety)
 * T-Markdown.12 — empty string returns empty string
 * T-Markdown.13 — plain paragraph unchanged
 *
 * Gate coverage: G-P8.4 (markdown renderer)
 *
 * No LLM, no Chrome, no filesystem.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdown } from "../../src/cli/markdown.js";

// Strip any ANSI escape sequences for content checks (chalk level=0 in tests
// so sequences should be absent, but we strip defensively for robustness).
function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI strip
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

// ─── T-Markdown.1: fenced code block ─────────────────────────────────────────

test("T-Markdown.1: fenced code block renders ╭─ header, │ body lines, ╰─ footer", () => {
  const md = "```javascript\nconsole.log('hello');\nconst x = 42;\n```";
  const rendered = stripAnsi(renderMarkdown(md));
  const lines = rendered.split("\n");

  // First line: ╭─ javascript
  assert.ok(lines[0]?.includes("╭─"), `line 0 should contain ╭─; got: "${lines[0]}"`);
  assert.ok(lines[0]?.includes("javascript"), `line 0 should include lang; got: "${lines[0]}"`);

  // Body lines prefixed with │
  assert.ok(lines[1]?.includes("│"), `line 1 should contain │; got: "${lines[1]}"`);
  assert.ok(lines[1]?.includes("console.log"), `line 1 should include code; got: "${lines[1]}"`);
  assert.ok(lines[2]?.includes("│"), `line 2 should contain │; got: "${lines[2]}"`);
  assert.ok(lines[2]?.includes("const x"), `line 2 should include code; got: "${lines[2]}"`);

  // Last line: ╰─
  const lastLine = lines[lines.length - 1];
  assert.ok(lastLine?.includes("╰─"), `last line should contain ╰─; got: "${lastLine}"`);
});

test("T-Markdown.1b: fenced code block with no language marker renders correctly", () => {
  const md = "```\nsome code\n```";
  const rendered = stripAnsi(renderMarkdown(md));
  assert.ok(rendered.includes("╭─"), "has opening fence marker");
  assert.ok(rendered.includes("some code"), "has code content");
  assert.ok(rendered.includes("╰─"), "has closing fence marker");
});

// ─── T-Markdown.2: h1 header ─────────────────────────────────────────────────

test("T-Markdown.2: h1 header text is preserved in output", () => {
  const rendered = stripAnsi(renderMarkdown("# Main Title"));
  assert.ok(rendered.includes("Main Title"), `h1 text should be present; got: "${rendered}"`);
  // The # marker itself should NOT appear (it's consumed by the regex)
  assert.ok(!rendered.includes("# "), `# marker should not appear raw in output; got: "${rendered}"`);
});

// ─── T-Markdown.3: h2/h3 headers ─────────────────────────────────────────────

test("T-Markdown.3: h2 and h3 headers text preserved", () => {
  const md = "## Section Two\n### Subsection Three";
  const rendered = stripAnsi(renderMarkdown(md));
  assert.ok(rendered.includes("Section Two"));
  assert.ok(rendered.includes("Subsection Three"));
});

// ─── T-Markdown.4: blockquote ────────────────────────────────────────────────

test("T-Markdown.4: blockquote renders with │ prefix", () => {
  const rendered = stripAnsi(renderMarkdown("> This is a quote."));
  assert.ok(rendered.includes("│"), `blockquote should have │ prefix; got: "${rendered}"`);
  assert.ok(rendered.includes("This is a quote."), "blockquote text preserved");
});

// ─── T-Markdown.5: unordered list ────────────────────────────────────────────

test("T-Markdown.5: unordered list renders with • bullet prefix", () => {
  const md = "- item one\n* item two\n- item three";
  const rendered = stripAnsi(renderMarkdown(md));
  // Each list item should have the • bullet
  const lines = rendered.split("\n");
  const bullets = lines.filter((l) => l.includes("•"));
  assert.equal(bullets.length, 3, `should have 3 bullet lines; got ${bullets.length}: ${JSON.stringify(bullets)}`);
  assert.ok(rendered.includes("item one"));
  assert.ok(rendered.includes("item two"));
  assert.ok(rendered.includes("item three"));
});

// ─── T-Markdown.6: ordered list ──────────────────────────────────────────────

test("T-Markdown.6: ordered list preserves numbers", () => {
  const md = "1. First item\n2. Second item\n3. Third item";
  const rendered = stripAnsi(renderMarkdown(md));
  assert.ok(rendered.includes("1."), "1. preserved");
  assert.ok(rendered.includes("2."), "2. preserved");
  assert.ok(rendered.includes("3."), "3. preserved");
  assert.ok(rendered.includes("First item"), "item text preserved");
});

// ─── T-Markdown.7: table separator row ───────────────────────────────────────

test("T-Markdown.7: table separator row rendered (plain text in test env)", () => {
  const md = "| Name | Value |\n|---|---|\n| Alice | 1 |";
  const rendered = stripAnsi(renderMarkdown(md));
  // The separator row should be present (may or may not have dim styling)
  assert.ok(
    rendered.includes("|---|---|") || rendered.includes("---|---"),
    `table separator row present; got: "${rendered}"`,
  );
  // Content rows pass through as normal lines
  assert.ok(rendered.includes("Alice"));
});

// ─── T-Markdown.8: inline code ───────────────────────────────────────────────

test("T-Markdown.8: inline code text visible", () => {
  const rendered = stripAnsi(renderMarkdown("Use `npm install` to install."));
  assert.ok(rendered.includes("npm install"), `inline code text visible; got: "${rendered}"`);
});

// ─── T-Markdown.9: bold text ─────────────────────────────────────────────────

test("T-Markdown.9: bold **text** and __text__ content visible", () => {
  const rendered = stripAnsi(renderMarkdown("This is **bold** and __also bold__."));
  assert.ok(rendered.includes("bold"), `bold text visible; got: "${rendered}"`);
  assert.ok(rendered.includes("also bold"), `bold text2 visible; got: "${rendered}"`);
});

// ─── T-Markdown.10: italic text ──────────────────────────────────────────────

test("T-Markdown.10: italic *text* and _text_ content visible", () => {
  const rendered = stripAnsi(renderMarkdown("This is *italic* and _also italic_."));
  assert.ok(rendered.includes("italic"), `italic text visible; got: "${rendered}"`);
  assert.ok(rendered.includes("also italic"), `italic text2 visible; got: "${rendered}"`);
});

// ─── T-Markdown.11: CJK text passes through unchanged ────────────────────────

test("T-Markdown.11: CJK text passes through without garbling (multi-byte safety)", () => {
  // Operator uses Chinese; this test guards against multi-byte corruption
  const cjkTexts = [
    "你是 Kyoube Lyu，是 Mastars Industries 的 BD。",
    "Pain Chain 第一步：找到关键角色",
    "价值：帮助 RevOps VP 解决 onboarding 效率问题",
    "## 下一步行动",
    "- 发现问题：引导对方说出痛点",
    "> 这是一个引用的中文内容",
  ];

  for (const text of cjkTexts) {
    const rendered = stripAnsi(renderMarkdown(text));
    // Extract CJK characters from the original and verify they're all in the output
    const cjkChars = text.match(/[一-鿿　-〿＀-￯]+/g) ?? [];
    for (const chunk of cjkChars) {
      assert.ok(rendered.includes(chunk), `CJK chunk "${chunk}" should be present in rendered output: "${rendered}"`);
    }
  }
});

// ─── T-Markdown.12: empty string ────────────────────────────────────────────

test("T-Markdown.12: empty string input returns empty string", () => {
  const rendered = renderMarkdown("");
  assert.equal(rendered, "");
});

// ─── T-Markdown.13: plain paragraph unchanged ────────────────────────────────

test("T-Markdown.13: plain paragraph passes through unchanged (no special markers)", () => {
  const plain = "This is a plain paragraph with no markdown.";
  const rendered = stripAnsi(renderMarkdown(plain));
  assert.ok(rendered.includes("This is a plain paragraph with no markdown."));
});

// ─── T-Markdown.14: mixed content renders all patterns correctly ──────────────

test("T-Markdown.14: mixed markdown renders all patterns in one pass", () => {
  const mixed = [
    "# Title",
    "",
    "Some **bold** and *italic* text with `inline code`.",
    "",
    "```python",
    "print('hello')",
    "```",
    "",
    "- list item one",
    "- list item **two**",
    "",
    "> blockquote content",
    "",
    "中文内容 mixed with english.",
  ].join("\n");

  const rendered = stripAnsi(renderMarkdown(mixed));

  assert.ok(rendered.includes("Title"), "h1 text");
  assert.ok(rendered.includes("bold"), "bold text");
  assert.ok(rendered.includes("italic"), "italic text");
  assert.ok(rendered.includes("inline code"), "inline code");
  assert.ok(rendered.includes("╭─"), "code block open");
  assert.ok(rendered.includes("print"), "code content");
  assert.ok(rendered.includes("╰─"), "code block close");
  assert.ok(rendered.includes("•"), "list bullet");
  assert.ok(rendered.includes("list item one"), "list item 1");
  assert.ok(rendered.includes("│"), "blockquote prefix");
  assert.ok(rendered.includes("blockquote content"), "blockquote text");
  assert.ok(rendered.includes("中文内容"), "CJK text preserved");
});
