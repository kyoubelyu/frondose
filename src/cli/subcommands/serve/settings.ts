// P-Y6 — in-app settings: masked read + write-only-key write-merge + hot-reload. Reuses the validated
// atomic helpers (no reimplementation). Custom-URL-only per P-57d: writes type:"openai" ALWAYS. The handler
// (routes.ts) sendJsons the result — the raw key never reaches SSE/audit/logs.
import { z } from "zod";
import { resolveModel } from "../../../agent/modelResolver.js";
import { BOUNDARY, BOUNDARY_RESUME } from "../../../agent/systemPrompt/boundary.js";
import { CHECKPOINT, CHECKPOINT_RESUME } from "../../../agent/systemPrompt/checkpoint.js";
import { composeSystemPrompt } from "../../../agent/systemPrompt/compose.js";
import { resolveSoulBand, soulModeFragment } from "../../../agent/systemPrompt/soul.js";
import {
  DEFAULT_DEEPSEEK_BASE_URL,
  getOfficialDirectProviderBaseUrlVendor,
  isAllowedRuntimeProviderEntry,
  isDeepSeekBaseUrl,
  isReservedDirectProviderName,
  maskKey,
  normalizeDeepSeekBaseUrl,
  readAuth,
  writeAuth,
} from "../../../persistence/auth.js";
import { DEFAULT_CONFIG_PATH, readConfig, writeConfig } from "../../../persistence/config.js";
import { applyIdentityPatch, readIdentity } from "../../../persistence/identity.js";
import { type IdentityPatch, identityPatchSchema } from "../../../persistence/identitySchema.js";
import { readMode } from "../../../persistence/mode.js";
import { readSearchConfig, writeSearchConfig } from "../../../persistence/search.js";
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
  search: { brave: { hasKey: boolean; maskedKey: string | null } };
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
      provider: z
        .string()
        .trim()
        .min(1)
        .refine((name) => !isReservedDirectProviderName(name), "Reserved direct providers are scope-disabled")
        .optional(),
      baseUrl: z
        .string()
        .trim()
        .url()
        .refine((url) => getOfficialDirectProviderBaseUrlVendor(url) === null, "Direct vendor URLs are scope-disabled")
        .optional(), // matches providerEntrySchema.baseUrl (auth.ts:21)
      model: z.string().trim().min(1).optional(),
      key: z.string().optional(), // write-only; isFreshKey gates it
    })
    .optional(),
  search: z.object({ brave: z.object({ key: z.string().optional() }).optional() }).optional(),
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

function chooseSettingsProvider(patch: SettingsPatch["llm"], currentProvider: string | null): string {
  const explicit = patch?.provider?.trim();
  if (explicit) return explicit;
  const baseUrl = patch?.baseUrl?.trim();
  if (isDeepSeekBaseUrl(baseUrl)) return "deepseek";
  if (patch?.model?.trim().toLowerCase().startsWith("deepseek")) return "deepseek";
  if (currentProvider && !isReservedDirectProviderName(currentProvider)) return currentProvider;
  return "custom";
}

export function readSettings(): SettingsView {
  const cfg = readConfig();
  const auth = readAuth();
  const search = readSearchConfig();
  const { provider, model } = splitSpec(auth?.default);
  const entry = provider ? auth?.providers?.[provider] : undefined;
  const key = entry?.key;
  const braveKey = search.braveApiKey?.trim();
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
    search: { brave: { hasKey: Boolean(braveKey), maskedKey: braveKey ? maskKey(braveKey) : null } },
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
    const provider = chooseSettingsProvider(patch.llm, cur.provider);
    const existing = auth.providers?.[provider];
    const key = isFreshKey(patch.llm.key, existing?.key) ? (patch.llm.key as string) : existing?.key;
    if (key) {
      // only write when we have a key (fresh or existing) — providerEntrySchema requires key.min(1)
      const submittedBaseUrl = patch.llm.baseUrl?.trim();
      const baseUrl =
        provider === "deepseek"
          ? normalizeDeepSeekBaseUrl(submittedBaseUrl ?? existing?.baseUrl ?? DEFAULT_DEEPSEEK_BASE_URL)
          : submittedBaseUrl ||
            (existing && isAllowedRuntimeProviderEntry(provider, existing) ? existing.baseUrl : undefined);
      if (provider !== "deepseek" && !baseUrl) return;
      const model = patch.llm.model?.trim() || (cur.provider === provider ? cur.model : null);
      writeAuth({
        default: model ? `${provider}:${model}` : auth.default,
        visionModel: auth.visionModel,
        providers: { ...(auth.providers ?? {}), [provider]: { key, baseUrl, type: "openai" } }, // P-57d
      });
    }
  }
  if (patch.search?.brave) {
    const existingSearch = readSearchConfig();
    const submitted = patch.search.brave.key?.trim();
    if (submitted && isFreshKey(submitted, existingSearch.braveApiKey)) {
      writeSearchConfig({ ...existingSearch, braveApiKey: submitted });
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
export function reloadAgentDeps(deps: Pick<ServeDeps, "system" | "model" | "systemResume">): {
  restartRequired: boolean;
} {
  try {
    const cfg = readConfig();
    const identity = readIdentity();
    // [P-75 D-15] Was hardcoded to "manual" — meaning a POST /settings hot-reload would
    // overwrite the Auto-band system prompt with a Manual-band one, breaking Auto mode
    // until restart. Read the current mode from mode.json so Auto stays Auto.
    const currentMode = readMode();
    const soulBand = `${resolveSoulBand(cfg.soul.override, identity)}\n\n${soulModeFragment(currentMode)}`;
    const newSystem = composeSystemPrompt({ boundary: BOUNDARY, soul: soulBand, checkpoint: CHECKPOINT });
    const newSystemResume = composeSystemPrompt({
      boundary: BOUNDARY_RESUME,
      soul: soulBand,
      checkpoint: CHECKPOINT_RESUME,
    });
    const newModel = resolveModel({}); // may throw if the new config is invalid
    deps.system = newSystem;
    deps.systemResume = newSystemResume;
    deps.model = newModel;
    return { restartRequired: false };
  } catch (e) {
    process.stderr.write(
      `[frondose] settings hot-reload failed (restart to apply): ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return { restartRequired: true };
  }
}
