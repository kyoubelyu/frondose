/**
 * P-13 D-6 / D-7 / D-8: `mai setup` wizard orchestrator.
 *
 * Linear 4-section flow gated by top-level checkbox; partial-save atomic per section.
 * Sections run in canonical order (auth → identity → telegram → soul) regardless of
 * operator selection order. NO back-navigation (matches hermes precedent).
 *
 * D-8: per-axis `select` prompt for the SOUL section is wizard-only — REPL `mai
 * soul reset` keeps its existing readline-based promptFreeAxes path unchanged.
 */
import { FREE_AXES } from "../../methodology/freeAxes.js";
import type { FreeAxesRecord } from "../../methodology/types.js";
import { applyIdentityPatch, identityRecordSchema, readIdentity, writeIdentity } from "../../persistence/identity.js";
import {
  isAuthConfigured,
  isIdentityConfigured,
  isInteractive,
  isSoulConfigured,
  isTelegramConfigured,
  type Prompter,
  realPrompter,
} from "./_prompts.js";
import { runAuthSubcommand } from "./auth.js";
import { runIdentitySubcommand } from "./identity.js";
import { runStatusSubcommand } from "./status.js";
import { runTelegramSubcommand } from "./telegram.js";

export interface SetupSubcommandOpts {
  authPath: string;
  identityPath: string;
  tcPath: string;
  schedulePath: string;
  memoryDbPath: string;
  cdpPort: number;
}

const SECTION_ORDER = ["auth", "identity", "telegram", "soul"] as const;
type SectionKey = (typeof SECTION_ORDER)[number];

export async function runSetupSubcommand(opts: SetupSubcommandOpts, prompter: Prompter = realPrompter): Promise<void> {
  // D-6 + T-Setup.1: non-interactive path → print current status + hint + exit cleanly.
  if (!isInteractive()) {
    process.stdout.write("mai setup — current configuration:\n");
    await runStatusSubcommand({
      authPath: opts.authPath,
      identityPath: opts.identityPath,
      schedulePath: opts.schedulePath,
      tcPath: opts.tcPath,
      memoryDbPath: opts.memoryDbPath,
      cdpPort: opts.cdpPort,
    });
    process.stderr.write("\nRun `mai setup` in an interactive terminal (TTY) to configure.\n");
    return;
  }

  process.stdout.write("\n◆ mai setup wizard\n\n");

  // D-6: top-level checkbox section picker. Each section pre-checked iff NOT configured.
  const checkboxChoices = [
    { name: "auth     — AI provider + API key", value: "auth", checked: !isAuthConfigured(opts.authPath) },
    {
      name: "identity — operator name/company/role",
      value: "identity",
      checked: !isIdentityConfigured(opts.identityPath),
    },
    { name: "telegram — bind Telegram user_id", value: "telegram", checked: !isTelegramConfigured(opts.tcPath) },
    { name: "soul     — 4 methodology habit axes", value: "soul", checked: !isSoulConfigured(opts.identityPath) },
  ];

  const selected = (await prompter.checkboxSections(checkboxChoices)) as SectionKey[];
  const selectedSet = new Set(selected);

  // D-6: canonical order enforced (NOT operator selection order).
  for (const section of SECTION_ORDER) {
    if (!selectedSet.has(section)) continue;
    switch (section) {
      case "auth":
        await runAuthSection(opts, prompter);
        break;
      case "identity":
        await runIdentitySection(opts, prompter);
        break;
      case "telegram":
        await runTelegramSection(opts, prompter);
        break;
      case "soul":
        await runSoulSection(opts, prompter);
        break;
    }
  }

  process.stdout.write("\n✓ Setup complete.\n\n");
  await runStatusSubcommand({
    authPath: opts.authPath,
    identityPath: opts.identityPath,
    schedulePath: opts.schedulePath,
    tcPath: opts.tcPath,
    memoryDbPath: opts.memoryDbPath,
    cdpPort: opts.cdpPort,
  });
}

async function runAuthSection(opts: SetupSubcommandOpts, prompter: Prompter): Promise<void> {
  // Idempotent re-run: show current → "Reconfigure? y/N" default false.
  if (isAuthConfigured(opts.authPath)) {
    const reconfig = await prompter.confirm("Auth already configured. Reconfigure?", false);
    if (!reconfig) return;
  }
  await runAuthSubcommand("set", { authPath: opts.authPath }, prompter);
}

async function runIdentitySection(opts: SetupSubcommandOpts, prompter: Prompter): Promise<void> {
  // C-2 fix: if identity.json already exists, prompt for reconfigure. Default false
  // means tests that pre-write identity.json + mock confirm → false skip
  // runIdentitySubcommand entirely (which is NOT DI-aware and would hang on readline).
  if (isIdentityConfigured(opts.identityPath)) {
    const reconfig = await prompter.confirm("Identity already configured. Reconfigure?", false);
    if (!reconfig) return;
  }
  await runIdentitySubcommand("init", { identityPath: opts.identityPath, reset: true });
}

async function runTelegramSection(opts: SetupSubcommandOpts, prompter: Prompter): Promise<void> {
  if (isTelegramConfigured(opts.tcPath)) {
    const reconfig = await prompter.confirm("Telegram already bound. Reconfigure?", false);
    if (!reconfig) return;
  }
  await runTelegramSubcommand("bind", { tcPath: opts.tcPath }, prompter);
}

async function runSoulSection(opts: SetupSubcommandOpts, prompter: Prompter): Promise<void> {
  if (isSoulConfigured(opts.identityPath)) {
    const reconfig = await prompter.confirm("Soul axes already configured. Reconfigure?", false);
    if (!reconfig) return;
  }
  const axes: FreeAxesRecord = await promptFreeAxesInteractive(prompter);
  const existing = readIdentity(opts.identityPath);
  if (!existing) {
    process.stderr.write(
      "[setup] identity.json missing during soul section — skipping (run identity section first).\n",
    );
    return;
  }
  const patched = applyIdentityPatch(existing, { freeAxes: axes });
  const merged = identityRecordSchema.parse({ ...patched, updatedAt: new Date().toISOString() });
  writeIdentity(merged, opts.identityPath);
  process.stdout.write("[setup] freeAxes saved.\n");
}

/**
 * D-8: per-axis `select` prompt — wizard only (REPL `soul reset` keeps readline path).
 *
 * N-3 fix Step 3b: use `_exhaustive: FreeAxesRecord = out;` direct assignment after the
 * loop (NOT `return out as FreeAxesRecord` double-cast). If a future phase adds a new
 * required key to FreeAxesRecord but the FREE_AXES object loses sync, the missing key
 * causes a tsc compile error here — runtime-silent failure becomes compile-time visible.
 */
async function promptFreeAxesInteractive(prompter: Prompter): Promise<FreeAxesRecord> {
  const out: Partial<FreeAxesRecord> = {};
  for (const axisKey of Object.keys(FREE_AXES) as (keyof FreeAxesRecord)[]) {
    const def = FREE_AXES[axisKey as string];
    if (!def) continue;
    const chosen = await prompter.axisSelect(
      String(axisKey),
      def.options.map((o) => ({ key: String(o.key), meaning: String(o.meaning) })),
    );
    out[axisKey] = chosen;
  }
  // N-3 fix: direct assignment (no cast) → tsc enforces every required FreeAxesRecord key is set.
  const _exhaustive: FreeAxesRecord = {
    pain_chain_lean: out.pain_chain_lean ?? "",
    lead_role: out.lead_role ?? "",
    discovery_lean: out.discovery_lean ?? "",
    story_shape: out.story_shape ?? "",
  };
  return _exhaustive;
}
