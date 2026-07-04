/**
 * T-ICP-PRECISION Step 5 RE-VALIDATION (validator, Sonnet) — SIMPLIFIED
 * (name-only) design, per plan §13. The company-URL machinery (identity
 * `companyLinkedInUrl`, and the boundary bootstrap-directive extension that
 * would have taught the agent to capture a company page URL) was
 * operator-directed scope creep and has been stripped entirely; `boundary.ts`
 * is REVERTED to its pre-phase text (already captures `company` — no
 * extension). `T-Boundary.CompanyUrl.1` is DELETED (its subject no longer
 * exists).
 *
 * Source-under-test: `composeSoulBand` (`src/agent/systemPrompt/soul.ts`),
 * `BOUNDARY` (`src/agent/systemPrompt/boundary.ts`, used only for the
 * composition-order invariant), and `composeSystemPrompt`
 * (`src/agent/systemPrompt/compose.ts`).
 *
 * Gates covered: plan §5 T-Soul.OwnCompany.1, T-Soul.OverrideICP.1,
 * T-Soul.Composition.1 — F-5 (soul.ts habit lines, name-only wording).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BOUNDARY } from "../../../src/agent/systemPrompt/boundary.js";
import { CHECKPOINT } from "../../../src/agent/systemPrompt/checkpoint.js";
import { composeSystemPrompt } from "../../../src/agent/systemPrompt/compose.js";
import { composeSoulBand } from "../../../src/agent/systemPrompt/soul.js";
import type { IdentityRecord } from "../../../src/persistence/identity.js";

function makeIdentity(): IdentityRecord {
  return {
    fullName: "Test Operator",
    company: "TestCo",
    role: "BD",
    persona: "You do outbound sales, methodology is Solution Selling®",
    icp: { targetRole: ["VP Sales"], industry: ["SaaS"] },
    style: "Direct, technical, empathetic",
    freeAxes: {
      pain_chain_lean: "cause-confirmed-then-up",
      lead_role: "pain-owner first",
      discovery_lean: "ratio-disciplined",
      story_shape: "reference-story led",
    },
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// T-Soul.OwnCompany.1 — new own-company habit line present + habitual wording
// ---------------------------------------------------------------------------

describe("composeSoulBand — new own-company worldview habit line (plan §5 T-Soul.OwnCompany.1, F-5)", () => {
  it("T-Soul.OwnCompany.1: given identity = a full IdentityRecord (or null), when composeSoulBand(identity) is called, then the output contains the exact literal 'own_company' AND the phrase 'you never prospect colleagues' (pins habitual, second-person, no-modal wording per soul.ts:17-22 conventions), AND does NOT contain the substring 'URL' or 'companyLinkedInUrl' (pins the §13 simplification — name-based only, no URL wording)", () => {
    // Given: a representative identity record.
    const identity = makeIdentity();

    // When: composeSoulBand(identity) is called.
    const band = composeSoulBand(identity);

    // Then: band.includes("own_company") && band.includes("you never prospect colleagues")
    //       && !band.includes("URL") && !band.includes("companyLinkedInUrl").
    assert.ok(band.includes("own_company"), `soul band must contain "own_company"; band=${band}`);
    assert.ok(
      band.includes("you never prospect colleagues"),
      `soul band must contain the habitual "you never prospect colleagues" phrase; band=${band}`,
    );
    assert.ok(!band.includes("URL"), `soul band must NOT contain "URL" (§13 name-only simplification); band=${band}`);
    assert.ok(
      !band.includes("companyLinkedInUrl"),
      `soul band must NOT contain "companyLinkedInUrl" (§13 name-only simplification); band=${band}`,
    );
  });

  it("T-Soul.OwnCompany.1b: given identity = null (bootstrap not yet run), when composeSoulBand(null) is called, then the output STILL contains 'own_company' (the habit line is identity-independent, always present)", () => {
    // Given: identity = null.
    // When: composeSoulBand(null) is called.
    const band = composeSoulBand(null);

    // Then: band.includes("own_company").
    assert.ok(band.includes("own_company"), `habit line must be present even with null identity; band=${band}`);
  });
});

// ---------------------------------------------------------------------------
// T-Soul.OverrideICP.1 — new effective-ICP-override habit line present
// ---------------------------------------------------------------------------

describe("composeSoulBand — new effective-ICP-override habit line (plan §5 T-Soul.OverrideICP.1, F-5, design A)", () => {
  it("T-Soul.OverrideICP.1: given identity = a full IdentityRecord, when composeSoulBand(identity) is called, then the output contains 'icp` override' AND \"operator's live intent\" (teaches the LLM to pass the operator's turn-instruction target as the qualify_profile/score_lead icp override param)", () => {
    // Given: a representative identity record.
    const identity = makeIdentity();

    // When: composeSoulBand(identity) is called.
    const band = composeSoulBand(identity);

    // Then: band.includes("icp` override") && band.includes("operator's live intent").
    assert.ok(band.includes("icp` override"), `soul band must contain "icp\` override"; band=${band}`);
    assert.ok(band.includes("operator's live intent"), `soul band must contain "operator's live intent"; band=${band}`);
  });
});

// ---------------------------------------------------------------------------
// T-Soul.Composition.1 — Boundary → Soul → Checkpoint order unchanged
// ---------------------------------------------------------------------------

describe("composeSystemPrompt — Boundary → Soul → Checkpoint composition order invariant unchanged by this phase (plan §5 T-Soul.Composition.1)", () => {
  it("T-Soul.Composition.1: given the real BOUNDARY, a composeSoulBand(identity) output, and the real CHECKPOINT constant, when composeSystemPrompt({boundary, soul, checkpoint}) is called, then the resulting string's indexOf(a stable BOUNDARY-only substring) < indexOf(a stable SOUL-only substring) < indexOf(a stable CHECKPOINT-only substring) — this pins the P-9 F-6 invariant (CLAUDE.md § Product Contract: 'Boundary → Soul → Checkpoint composition order is invariant') and proves this phase's soul/boundary CONTENT edits do not disturb band ORDER", () => {
    // Given: the real 3 bands, composed via the actual production composer.
    const identity = makeIdentity();
    const soul = composeSoulBand(identity);
    const composed = composeSystemPrompt({ boundary: BOUNDARY, soul, checkpoint: CHECKPOINT });

    // A stable substring unique to each band (independent of this phase's edits).
    const boundaryMarker = "running on a single Mac driving a single Chrome browser";
    const soulMarker = "Your mission on LinkedIn";
    const checkpointMarker = "CHECKPOINT DISCIPLINE";

    // When: locate each marker's index in the composed string.
    const iBoundary = composed.indexOf(boundaryMarker);
    const iSoul = composed.indexOf(soulMarker);
    const iCheckpoint = composed.indexOf(checkpointMarker);

    // Then: iBoundary >= 0 && iSoul > iBoundary && iCheckpoint > iSoul.
    assert.ok(
      iBoundary >= 0 && iSoul > iBoundary && iCheckpoint > iSoul,
      `Boundary→Soul→Checkpoint order invariant must hold; iBoundary=${iBoundary}, iSoul=${iSoul}, iCheckpoint=${iCheckpoint}`,
    );
  });
});
