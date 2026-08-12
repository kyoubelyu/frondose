import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BOUNDARY, BOUNDARY_RESUME, boundaryLanguageDirective } from "../../../src/agent/systemPrompt/boundary.js";
import { CHECKPOINT, CHECKPOINT_RESUME } from "../../../src/agent/systemPrompt/checkpoint.js";
import { BAND_SEPARATOR, composeSystemPrompt } from "../../../src/agent/systemPrompt/compose.js";
import { composeSoulBand, soulModeFragment } from "../../../src/agent/systemPrompt/soul.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SERVE_TS = readFileSync(join(REPO, "src/app/backend/index.ts"), "utf8");

const SECOND_ATTEMPT_START = "(2) SECOND attempt";
const THIRD_ATTEMPT_START = "(3) THIRD attempt";
const DYNAMIC_FALLBACK_MARKER = "dynamic overlay/listbox/typeahead";

const EXPECTED_SECOND_ATTEMPT =
  '(2) SECOND attempt (if primary fails with a non-transient error — NOT a network blip or single 5xx): try the FALLBACK suggested by the tool-preference hints above. Examples: `analyze_screenshot` returns `vision_unavailable` → use `inspect` accessibility-tree; `web_search` returns `missing_config` or `search_error` → use LinkedIn navigation (`navigate_to_url` + `inspect` + `click`) or `web_fetch` to known URLs; `click {label}` returns `ambiguous_target` → on a dynamic overlay/listbox/typeahead, IGNORE any generic tool-result suggestion to "use ref directly" or use an "exact ref": those candidate refs can already be stale after a re-render. Do NOT reuse any ref from the error, do NOT reuse an older ref, and do NOT press Enter to guess. Run `inspect` again and retry `click` with the full, unique visible candidate label reproduced with whitespace normalized to ordinary spaces (a more specific label). Use `ref` only when that fresh inspect proves a static surface and the chosen ref is current; `inspect` returns empty / missing target → `screenshot` + `scroll` + re-inspect; connect button not found at expected position → check `More` menu for `Connect`.';

function extractSecondAttempt(boundary: string): string {
  const start = boundary.indexOf(SECOND_ATTEMPT_START);
  const end = boundary.indexOf(THIRD_ATTEMPT_START, start);
  assert.notEqual(start, -1, "Boundary must contain the second-attempt marker");
  assert.notEqual(end, -1, "Boundary must contain the third-attempt marker after the second attempt");
  return boundary.slice(start, end).trim();
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("Boundary ambiguous-target recovery", () => {
  // Given the complete second-attempt protocol, when extracted, then it is byte-locked to the approved dynamic-picker recovery.
  it("T-AMB.1: locks the full second-attempt clause to fresh-inspect plus unique-label recovery", () => {
    assert.equal(extractSecondAttempt(BOUNDARY), EXPECTED_SECOND_ATTEMPT);
  });

  // Given the whole Boundary, when unsafe and override phrases are counted, then no contradictory ref-first recovery can coexist.
  it("T-AMB.2: removes the old ref-first directive and keeps each dynamic override unique", () => {
    assert.ok(!BOUNDARY.includes("retry with `ref` instead of `label`"));
    assert.equal(countOccurrences(BOUNDARY, '"use ref directly"'), 1);
    assert.equal(countOccurrences(BOUNDARY, '"exact ref"'), 1);
    assert.equal(countOccurrences(BOUNDARY, DYNAMIC_FALLBACK_MARKER), 1);
  });

  // Given the Self-report section, when protocol anchors are located, then fallback, issue, stop, and never-silent ordering remains intact.
  it("T-AMB.3: preserves fallback-to-issue-to-stop sequencing and non-transient kinds", () => {
    const start = BOUNDARY.indexOf("## Self-report + fallback protocol");
    const end = BOUNDARY.indexOf("## Memory-first passive-observation responses", start);
    assert.ok(start >= 0 && end > start, "Self-report section must remain bounded by its two headers");
    const section = BOUNDARY.slice(start, end);

    const first = section.indexOf("(1) FIRST attempt");
    const second = section.indexOf(SECOND_ATTEMPT_START);
    const third = section.indexOf(THIRD_ATTEMPT_START);
    const issue = section.indexOf("file `gh_issue` automatically", third);
    const stop = section.indexOf("Then call `stop`.", issue);
    const neverSilent = section.indexOf("(4) Never exit silently", stop);
    assert.ok(
      first >= 0 && first < second && second < third && third < issue && issue < stop && stop < neverSilent,
      "Self-report sequence must remain first → second → third → gh_issue → stop → never-silent",
    );
    assert.ok(section.includes("failure:<toolName>:<error.kind>"));
    for (const kind of [
      "runtime_error",
      "vision_unavailable",
      "scope_disabled",
      "missing_config",
      "search_error",
      "ambiguous_target",
      "invalid_input",
      "not_found",
    ]) {
      assert.ok(section.includes(`\`${kind}\``), `Self-report section must retain non-transient kind ${kind}`);
    }
  });

  // Given production prompt assembly, when language and mode variants are composed, then the exact effective Boundary→Soul→Checkpoint arrays remain stable.
  it("T-AMB.4: propagates to resume and pins the production normal/operator/resume band arrays", () => {
    assert.equal(countOccurrences(BOUNDARY_RESUME, EXPECTED_SECOND_ATTEMPT), 1);

    for (const marker of [
      "const boundaryBand = `\u0024{BOUNDARY}\u0024{languageDirective}`;",
      "const boundaryResumeBand = `\u0024{BOUNDARY_RESUME}\u0024{languageDirective}`;",
      "const system = composeSystemPrompt({ boundary: boundaryBand, soul: soulBandPlain, checkpoint: CHECKPOINT });",
      "boundary: boundaryResumeBand,",
      "soul: soulBandWithMode,",
      "checkpoint: CHECKPOINT_RESUME,",
      "const composeOperatorSystem = (mode: AppMode): string =>",
      "soul: `\u0024{soulBandPlain}\\n\\n\u0024{soulModeFragment(mode)}`,",
    ]) {
      assert.ok(SERVE_TS.includes(marker), `backend index.ts must retain production assembly marker: ${marker}`);
    }

    const soulPlain = composeSoulBand(null);
    const boot = composeSystemPrompt({ boundary: BOUNDARY, soul: soulPlain, checkpoint: CHECKPOINT });
    assert.deepEqual(boot.split(BAND_SEPARATOR), [BOUNDARY, soulPlain, CHECKPOINT]);

    for (const lang of ["auto", "en", "zh"] as const) {
      const languageDirective = boundaryLanguageDirective(lang);
      const boundaryBand = `${BOUNDARY}${languageDirective}`;
      const boundaryResumeBand = `${BOUNDARY_RESUME}${languageDirective}`;
      for (const mode of ["manual", "magical", "auto"] as const) {
        const soulWithMode = `${soulPlain}\n\n${soulModeFragment(mode)}`;
        const operator = composeSystemPrompt({
          boundary: boundaryBand,
          soul: soulWithMode,
          checkpoint: CHECKPOINT,
        });
        const resume = composeSystemPrompt({
          boundary: boundaryResumeBand,
          soul: soulWithMode,
          checkpoint: CHECKPOINT_RESUME,
        });
        assert.deepEqual(operator.split(BAND_SEPARATOR), [boundaryBand, soulWithMode, CHECKPOINT]);
        assert.deepEqual(resume.split(BAND_SEPARATOR), [boundaryResumeBand, soulWithMode, CHECKPOINT_RESUME]);
      }
    }
  });
});
