/**
 * P-UI-THINK-OVERLAY item (2) — the CDP overlay's own chat input/send controls are feature-hidden.
 *
 * Operator direction (verbatim intent, ROADMAP.md § Phase P-UI-THINK-OVERLAY): "现在先隐藏 CDP
 * overlay 内的对话框按钮功能,优先完成 main 窗口的更新" — hide the overlay's composer (its
 * conversation diverges from the main window's), keep the code intact for the later P-UI-CONVERGE
 * phase to decide the overlay's fate. Approval/status/progress surfaces (workflow card, auto-stage,
 * mode badge) are UNAFFECTED — only the chat input/send footer is hidden.
 *
 * Testing strategy (same split as conversationOverlay.mock.test.ts): SHELL_JS runs only in a
 * browser shadow-DOM context, so source-structural assertions pin bootstrapShell.ts's gating
 * construct, and a behavioral simulation (mirroring the exact buildPanelSkeleton algorithm)
 * proves the composer/footer ends up hidden while the rest of the skeleton is untouched.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/overlay/hideChatControls-pUiThinkOverlay.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SHELL_TS = readFileSync(join(REPO, "src/overlay/bootstrapShell.ts"), "utf-8");

// ─── Source-structural: the gating flag + its wiring exist in bootstrapShell.ts ──────────────

describe("bootstrapShell.ts — overlay chat controls are feature-hidden behind a named const (P-UI-THINK-OVERLAY)", () => {
  it("T-HideChat.SRC.1: SHELL_JS declares OVERLAY_CHAT_CONTROLS_ENABLED = false", () => {
    // Given: the SHELL_JS template literal in bootstrapShell.ts
    // When:  scanned for the gating flag declaration
    // Then:  it exists and defaults to false (hidden by default, per operator direction)
    assert.ok(
      SHELL_TS.includes("var OVERLAY_CHAT_CONTROLS_ENABLED = false;"),
      "bootstrapShell.ts must declare 'var OVERLAY_CHAT_CONTROLS_ENABLED = false;' inside SHELL_JS",
    );
  });

  it("T-HideChat.SRC.2: the composer footer is still fully constructed (feature-hide, not delete)", () => {
    // Given: the SHELL_JS buildPanelSkeleton body
    // When:  scanned for the composer/input/send DOM construction
    // Then:  input#command-input, send-btn, and the keydown->post({type:'prompt'}) listener are
    //        ALL still present — the code is kept, only its visibility is gated (operator: "保留代码")
    assert.ok(SHELL_TS.includes("input.id = 'command-input'"), "the #command-input element must still be built");
    assert.ok(SHELL_TS.includes("'composer-send', 'send-btn'"), "the #send-btn element must still be built");
    assert.ok(
      SHELL_TS.includes("post({ type:'prompt', text:t, t0:Date.now() })"),
      "the composer's Enter->post(prompt) listener must still be wired",
    );
  });

  it("T-HideChat.SRC.3: footer.classList.add('hidden') is gated behind !OVERLAY_CHAT_CONTROLS_ENABLED, AFTER footer is appended to panelRoot", () => {
    // Given: the SHELL_JS buildPanelSkeleton body
    // When:  the index of the hide-gate is compared to the index of panelRoot.appendChild(footer)
    // Then:  the gate runs after the footer (composer) is fully built + attached — hiding an
    //        already-complete DOM subtree, never skip-constructing it
    const attachIdx = SHELL_TS.indexOf("panelRoot.appendChild(footer);");
    const gateIdx = SHELL_TS.indexOf("if (!OVERLAY_CHAT_CONTROLS_ENABLED) { footer.classList.add('hidden'); }");
    assert.ok(attachIdx >= 0, "footer must be appended to panelRoot");
    assert.ok(gateIdx >= 0, "the OVERLAY_CHAT_CONTROLS_ENABLED hide-gate must exist");
    assert.ok(gateIdx > attachIdx, "the hide-gate must run AFTER footer is attached (hide, not skip-build)");
  });

  it("T-HideChat.SRC.4: dialogElements still exposes .input (composer object graph unchanged — no external read sites broken)", () => {
    // Given: the dialogElements assignment in buildPanelSkeleton
    // When:  scanned for the 'input: input' property
    // Then:  it is still present — dialogElements' shape is untouched by the hide (defensive:
    //        anything that reads dialogElements.input later still gets a real element, just hidden)
    assert.ok(
      SHELL_TS.includes("dialogElements = { ticker: ticker, convList: convList, input: input,"),
      "dialogElements must still assign input: input (object shape unchanged by the feature-hide)",
    );
  });

  it("T-HideChat.SRC.5: approval + status/progress surfaces (workflow card, auto-stage, mode badge) are NOT gated by OVERLAY_CHAT_CONTROLS_ENABLED", () => {
    // Given: the SHELL_JS source
    // When:  the workflow-card / auto-stage / status-line construction is scanned
    // Then:  none of those builders are wrapped in an OVERLAY_CHAT_CONTROLS_ENABLED check —
    //        only the composer/footer is gated (operator: read-only displays stay)
    const workflowCardIdx = SHELL_TS.indexOf("buildWorkflowCardSkeleton()");
    const autoStageIdx = SHELL_TS.indexOf("'auto-stage hidden', 'auto-stage'");
    const statusLineIdx = SHELL_TS.indexOf("'status-line'");
    assert.ok(workflowCardIdx >= 0 && autoStageIdx >= 0 && statusLineIdx >= 0, "all three surfaces must exist");
    const gateIdx = SHELL_TS.indexOf("var OVERLAY_CHAT_CONTROLS_ENABLED");
    // The flag is declared once, well before any of these surfaces; none of their construction
    // lines contain the flag name (i.e. they are unconditional).
    for (const [label, idx] of [
      ["workflow card", workflowCardIdx],
      ["auto-stage", autoStageIdx],
      ["status line", statusLineIdx],
    ] as const) {
      const lineStart = SHELL_TS.lastIndexOf("\n", idx);
      const lineEnd = SHELL_TS.indexOf("\n", idx);
      const line = SHELL_TS.slice(lineStart, lineEnd);
      assert.ok(
        !line.includes("OVERLAY_CHAT_CONTROLS_ENABLED"),
        `${label} construction must NOT be gated by the chat-controls flag`,
      );
    }
    assert.ok(gateIdx >= 0, "sanity: the flag itself must be declared somewhere in the file");
  });
});

// ─── Behavioral — the built footer ends up hidden while the rest of the skeleton is untouched ──

type FakeEl = {
  tag: string;
  id: string;
  classes: Set<string>;
  children: FakeEl[];
  classList: { add: (...c: string[]) => void; contains: (c: string) => boolean };
};

function makeFakeEl(tag = "div", id = "", cls = ""): FakeEl {
  const classes = new Set<string>(cls.split(" ").filter(Boolean));
  return {
    tag,
    id,
    classes,
    children: [],
    classList: {
      add: (...cs: string[]) => {
        for (const c of cs) classes.add(c);
      },
      contains: (c: string) => classes.has(c),
    },
  };
}

// Mirrors the relevant slice of SHELL_JS's buildPanelSkeleton: builds a footer/composer subtree
// and applies the same conditional hide the production code now applies.
function buildFooterMirror(overlayChatControlsEnabled: boolean): FakeEl {
  const footer = makeFakeEl("footer", "", "footer");
  const composer = makeFakeEl("div", "composer", "composer");
  const inner = makeFakeEl("div", "", "composer-inner");
  const input = makeFakeEl("input", "command-input", "");
  const send = makeFakeEl("button", "send-btn", "composer-send");
  inner.children.push(input, send);
  composer.children.push(inner);
  footer.children.push(composer);
  if (!overlayChatControlsEnabled) footer.classList.add("hidden");
  return footer;
}

describe("overlay footer visibility mirrors OVERLAY_CHAT_CONTROLS_ENABLED (P-UI-THINK-OVERLAY behavioral proof)", () => {
  it("T-HideChat.1: with the flag false (shipped default), the footer carries .hidden but its composer/input/send children are still built", () => {
    // Given: OVERLAY_CHAT_CONTROLS_ENABLED = false (the shipped default)
    // When:  the footer subtree is built
    // Then:  footer.classList.contains('hidden') === true, AND input#command-input +
    //        button#send-btn both still exist in the tree (feature-hide, not delete)
    const footer = buildFooterMirror(false);
    assert.ok(footer.classList.contains("hidden"), "footer must carry .hidden when the flag is false");
    const input = footer.children[0]?.children[0]?.children[0];
    const send = footer.children[0]?.children[0]?.children[1];
    assert.equal(input?.id, "command-input", "the #command-input element must still exist in the DOM tree");
    assert.equal(send?.id, "send-btn", "the #send-btn element must still exist in the DOM tree");
  });

  it("T-HideChat.2: with the flag true (re-enable path), the footer carries NO .hidden class", () => {
    // Given: OVERLAY_CHAT_CONTROLS_ENABLED = true (the documented re-enable flip)
    // When:  the footer subtree is built
    // Then:  footer.classList.contains('hidden') === false — a one-line flip fully restores the UI
    const footer = buildFooterMirror(true);
    assert.equal(footer.classList.contains("hidden"), false, "footer must NOT carry .hidden when the flag is true");
  });
});

// ─── FM-1 critic NIT-1 — the gate survives the ASSEMBLED bootstrap bundle ────────────────────
// The SRC tests above scan bootstrapShell.ts (the fragment); this suite imports the production
// bootstrap assembler and asserts the interpolated OVERLAY_BOOTSTRAP_JS still carries the flag,
// the gate, and the .hidden CSS rule — catching an interpolation/codegen regression the fragment
// scan would miss. (A true shadow-root execution needs a browser; that's the FM-3/on-glass check.)

describe("OVERLAY_BOOTSTRAP_JS — the chat-controls gate survives bundle assembly (P-UI-THINK-OVERLAY NIT-1)", () => {
  it("T-HideChat.ASM.1: the assembled bootstrap contains the flag declaration, the hide-gate, and a .hidden display:none rule", async () => {
    // Given: the production assembler src/overlay/bootstrap.ts (SHELL_JS interpolated + FRONDOSE_CSS embedded)
    // When:  OVERLAY_BOOTSTRAP_JS is imported and scanned
    // Then:  all three load-bearing pieces are present in the final injected source
    const { OVERLAY_BOOTSTRAP_JS } = await import("../../src/overlay/bootstrap.js");
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("var OVERLAY_CHAT_CONTROLS_ENABLED = false;"),
      "assembled bundle must carry the flag declaration",
    );
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("if (!OVERLAY_CHAT_CONTROLS_ENABLED) { footer.classList.add('hidden'); }"),
      "assembled bundle must carry the hide-gate",
    );
    assert.ok(
      /\.hidden\s*\{\s*display:\s*none/.test(OVERLAY_BOOTSTRAP_JS),
      "assembled bundle's embedded FRONDOSE_CSS must carry the .hidden display:none rule the gate relies on",
    );
  });
});
