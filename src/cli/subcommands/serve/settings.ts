// P-Y6 — in-app settings: masked read + write-only-key write-merge + hot-reload. Reuses the validated
// atomic helpers (no reimplementation). Custom-URL-only per P-57d: writes type:"openai" ALWAYS. The handler
// (routes.ts) sendJsons the result — the raw key never reaches SSE/audit/logs.
import { z } from "zod";
import { resolveModel } from "../../../agent/modelResolver.js";
import { BOUNDARY } from "../../../agent/systemPrompt/boundary.js";
import { CHECKPOINT } from "../../../agent/systemPrompt/checkpoint.js";
import { composeSystemPrompt } from "../../../agent/systemPrompt/compose.js";
import { resolveSoulBand, soulModeFragment } from "../../../agent/systemPrompt/soul.js";
import { maskKey, readAuth, writeAuth } from "../../../persistence/auth.js";
import { DEFAULT_CONFIG_PATH, readConfig, writeConfig } from "../../../persistence/config.js";
import { applyIdentityPatch, readIdentity } from "../../../persistence/identity.js";
import { type IdentityPatch, identityPatchSchema } from "../../../persistence/identitySchema.js";
import type { ServeDeps } from "./context.js";

export interface SettingsView {
  llm: {
    provider: string | null;
    baseUrl: string | null;
    model: string | null;
    defaultSpec: string | null;
    hasKey: boolean;
    maskedKey: string | null;
  };
  identity: IdentityPatch;
  soul: { override: string | null };
  updateServerUrl: string | null; // P-58d.1: plaintext, NOT masked (contrast llm.maskedKey)
}

// Step-3b CONCERN-MR — validate-before-write. The write helpers are atomic but do NOT validate SHAPE;
// readConfig validates on READ, so a malformed persisted body would break the NEXT boot. Zod-parse the
// POST body against the EXISTING schemas (identityPatchSchema; the soul ≤3000 + nullable constraint
// mirroring config.ts soulSubSchema; the provider baseUrl URL constraint mirroring auth providerEntrySchema)
// BEFORE writing. type:"openai" is forced on write (P-57d), not in the patch. Unknown keys are stripped
// (default zod object behavior) — only malformed VALUES (wrong type / oversized / bad URL) fail.
const settingsPatchSchema = z.object({
  llm: z
    .object({
      provider: z.string().trim().min(1).optional(),
      baseUrl: z.string().url().optional(), // matches providerEntrySchema.baseUrl (auth.ts:21)
      model: z.string().trim().min(1).optional(),
      key: z.string().optional(), // write-only; isFreshKey gates it
    })
    .optional(),
  identity: identityPatchSchema.optional(), // EXISTING schema (identitySchema.ts:44)
  soul: z.object({ override: z.string().max(3000).nullable() }).optional(), // EXISTING ≤3000 constraint
  updateServerUrl: z.string().url().nullable().optional(), // P-58d.1: omit=unchanged, null=clear, url=set
});
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

/** Validate the POST body against the existing schemas. ok:false → the route 400s + writes NOTHING. */
export function parseSettingsPatch(body: unknown): { ok: true; patch: SettingsPatch } | { ok: false; error: string } {
  const r = settingsPatchSchema.safeParse(body ?? {});
  return r.success ? { ok: true, patch: r.data } : { ok: false, error: r.error.message };
}

function splitSpec(spec: string | undefined): { provider: string | null; model: string | null } {
  if (!spec) return { provider: null, model: null };
  const i = spec.indexOf(":");
  return i > 0 ? { provider: spec.slice(0, i), model: spec.slice(i + 1) } : { provider: null, model: null };
}

export function readSettings(): SettingsView {
  const cfg = readConfig();
  const auth = readAuth();
  const { provider, model } = splitSpec(auth?.default);
  const entry = provider ? auth?.providers?.[provider] : undefined;
  const key = entry?.key;
  const { updatedAt, ...identity } = cfg.identity ?? ({} as Record<string, unknown>);
  void updatedAt; // intentionally stripped from the view (no updatedAt leak)
  return {
    llm: {
      provider,
      baseUrl: entry?.baseUrl ?? null,
      model,
      defaultSpec: auth?.default ?? null,
      hasKey: Boolean(key),
      maskedKey: key ? maskKey(key) : null,
    },
    identity: identity as IdentityPatch,
    soul: { override: cfg.soul.override },
    updateServerUrl: cfg.updateServerUrl, // P-58d.1: plaintext
  };
}

// A key is "fresh" only if it's a non-empty value that is NOT the mask of the existing key and contains
// no mask markers — so a save that didn't touch the key (UI echoes the mask / empty) never rewrites it.
export function isFreshKey(submitted: string | undefined, existing: string | undefined): boolean {
  if (!submitted) return false;
  if (existing && submitted === maskKey(existing)) return false;
  if (/[•*]{2,}/.test(submitted)) return false; // belt-and-suspenders: any mask-shaped value
  return true;
}

export function applySettings(patch: SettingsPatch): void {
  if (patch.llm) {
    const auth = readAuth() ?? {};
    const cur = splitSpec(auth.default);
    const provider = patch.llm.provider?.trim() || cur.provider || "custom";
    const existing = auth.providers?.[provider];
    const key = isFreshKey(patch.llm.key, existing?.key) ? (patch.llm.key as string) : existing?.key;
    if (key) {
      // only write when we have a key (fresh or existing) — providerEntrySchema requires key.min(1)
      const baseUrl = patch.llm.baseUrl?.trim() || existing?.baseUrl;
      const model = patch.llm.model?.trim() || (cur.provider === provider ? cur.model : null);
      writeAuth({
        default: model ? `${provider}:${model}` : auth.default,
        visionModel: auth.visionModel,
        providers: { ...(auth.providers ?? {}), [provider]: { key, baseUrl, type: "openai" } }, // P-57d
      });
    }
  }
  if (patch.identity || patch.soul || patch.updateServerUrl !== undefined) {
    const cfg = readConfig();
    const next = { ...cfg };
    if (patch.identity) {
      const merged = applyIdentityPatch(cfg.identity ?? {}, patch.identity);
      next.identity = { ...merged, updatedAt: new Date().toISOString() } as typeof cfg.identity;
    }
    if (patch.soul) next.soul = { override: patch.soul.override ?? null };
    if (patch.updateServerUrl !== undefined) next.updateServerUrl = patch.updateServerUrl; // P-58d.1
    writeConfig(next, DEFAULT_CONFIG_PATH());
  }
}

// Hot-reload the per-turn-read deps (turn.ts reads deps.system/deps.model each turn). Compute BOTH into
// locals BEFORE assigning so a resolveModel throw leaves the OLD deps fully intact (atomic).
export function reloadAgentDeps(deps: Pick<ServeDeps, "system" | "model">): { restartRequired: boolean } {
  try {
    const cfg = readConfig();
    const identity = readIdentity();
    const newSystem = composeSystemPrompt({
      boundary: BOUNDARY,
      soul: `${resolveSoulBand(cfg.soul.override, identity)}\n\n${soulModeFragment("manual")}`,
      checkpoint: CHECKPOINT,
    });
    const newModel = resolveModel({}); // may throw if the new config is invalid
    deps.system = newSystem;
    deps.model = newModel;
    return { restartRequired: false };
  } catch (e) {
    process.stderr.write(
      `[mai] settings hot-reload failed (restart to apply): ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return { restartRequired: true };
  }
}
