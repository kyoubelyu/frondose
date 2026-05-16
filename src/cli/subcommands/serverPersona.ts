/** P-27: `mai server persona add/list/show/remove` action dispatcher.
 *
 *  Persona templates are JSON files under ~/.mai/server/personas/<id>.json.
 *  `add` accepts `--from-template` as EITHER a persona ID (copy an existing
 *  template) OR an inline JSON string (scripted create). When a template is
 *  supplied and the session is non-interactive, the template is written
 *  directly; otherwise the operator is prompted field-by-field.
 *
 *  Error conditions THROW (caller maps to exit 1) so the dispatcher is
 *  unit-testable without killing the test runner. */
import {
  deletePersonaTemplate,
  listPersonaTemplates,
  type PersonaTemplate,
  personaTemplateSchema,
  readPersonaTemplate,
  writePersonaTemplate,
} from "../../persistence/personaLibrary.js";
import { SERVER_PERSONAS_DIR } from "../../persistence/serverPaths.js";
import { isInteractive, realPrompter } from "./_prompts.js";

/** Minimal prompter surface for persona prompts: `question(fieldKey, promptText)`. */
export interface PersonaPrompter {
  question(key: string, prompt: string): Promise<string>;
}

/** Default prompter — wraps the canonical `_prompts.ts` realPrompter.input(). */
export const realPersonaPrompter: PersonaPrompter = {
  question: (_key, prompt) => realPrompter.input(prompt),
};

export interface ServerPersonaOpts {
  personaId?: string;
  json?: boolean;
  fromTemplate?: string;
}

/** Resolve `--from-template` to a PersonaTemplate: inline JSON object, else a
 *  persona ID looked up in `dir`. Returns null when neither resolves. */
function resolveTemplate(dir: string, fromTemplate: string): PersonaTemplate | null {
  const trimmed = fromTemplate.trim();
  if (trimmed.startsWith("{")) {
    try {
      return personaTemplateSchema.parse(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  return readPersonaTemplate(dir, trimmed);
}

export async function runServerPersonaSubcommand(
  action: "add" | "list" | "show" | "remove",
  opts: ServerPersonaOpts,
  prompter: PersonaPrompter = realPersonaPrompter,
): Promise<void> {
  const dir = SERVER_PERSONAS_DIR();

  if (action === "list") {
    const ids = listPersonaTemplates(dir);
    if (opts.json) {
      const out = ids.map((id) => {
        const t = readPersonaTemplate(dir, id);
        return { id, fullName: t?.fullName ?? null, role: t?.role ?? null, company: t?.company ?? null };
      });
      process.stdout.write(`${JSON.stringify(out)}\n`);
      return;
    }
    if (ids.length === 0) {
      process.stdout.write("(no personas configured)\n");
      return;
    }
    process.stdout.write("PERSONA_ID    FULL_NAME         ROLE            COMPANY\n");
    for (const id of ids) {
      const t = readPersonaTemplate(dir, id);
      process.stdout.write(
        `${id.padEnd(14)}${(t?.fullName ?? "").padEnd(18)}${(t?.role ?? "").padEnd(16)}${t?.company ?? ""}\n`,
      );
    }
    return;
  }

  if (!opts.personaId) {
    throw new Error(`[server persona ${action}] missing <persona_id>`);
  }

  if (action === "show") {
    const t = readPersonaTemplate(dir, opts.personaId);
    if (!t) throw new Error(`[server persona show] ${opts.personaId} not found`);
    process.stdout.write(`${JSON.stringify(t, null, 2)}\n`);
    return;
  }

  if (action === "remove") {
    const ok = deletePersonaTemplate(dir, opts.personaId);
    if (!ok) throw new Error(`[server persona remove] ${opts.personaId} not found`);
    process.stdout.write(`[persona remove] ${opts.personaId} deleted\n`);
    return;
  }

  // action === "add"
  let template: PersonaTemplate | null = null;
  if (opts.fromTemplate) {
    template = resolveTemplate(dir, opts.fromTemplate);
    if (!template) {
      throw new Error(`[server persona add] template ${opts.fromTemplate} not found or invalid`);
    }
  }

  // Non-interactive: a resolved template is written directly (scripted/copy path).
  if (template && !isInteractive()) {
    writePersonaTemplate(dir, opts.personaId, { ...template, updatedAt: new Date().toISOString() });
    process.stdout.write(
      `[persona add] ${opts.personaId} written. Use in: provision_worker('${opts.personaId}', ...)\n`,
    );
    return;
  }

  if (!isInteractive()) {
    throw new Error(`[server persona add] requires TTY for interactive prompts (or pass --from-template)`);
  }

  // Interactive prompts — `template` (if any) supplies the defaults.
  const ask = async (key: string, label: string, def?: string): Promise<string> => {
    const hint = def ? ` [${def}]` : "";
    const answer = (await prompter.question(key, `${label}${hint}: `)).trim();
    return answer || (def ?? "");
  };
  const fullName = await ask("fullName", "fullName", template?.fullName);
  const role = await ask("role", "role (optional)", template?.role);
  const company = await ask("company", "company (optional)", template?.company);
  const linkedInUrl = await ask("linkedInUrl", "linkedInUrl (optional)", template?.linkedInUrl);
  const email = await ask("email", "email (optional)", template?.email);
  const prioritiesRaw = await ask(
    "priorities",
    "priorities (comma-separated, optional)",
    (template?.priorities ?? []).join(", "),
  );
  const traitsRaw = await ask("traits", "traits (comma-separated, optional)", (template?.traits ?? []).join(", "));
  const emailTemplate = await ask("emailTemplate", "emailTemplate (optional)", template?.emailTemplate);
  const soulBandOverride = await ask("soulBandOverride", "soulBandOverride (optional)", template?.soulBandOverride);

  const t = personaTemplateSchema.parse({
    fullName,
    role: role || undefined,
    company: company || undefined,
    linkedInUrl: linkedInUrl || undefined,
    email: email || undefined,
    emailTemplate: emailTemplate || undefined,
    soulBandOverride: soulBandOverride || undefined,
    priorities: prioritiesRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 8),
    traits: traitsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 8),
    updatedAt: new Date().toISOString(),
  });
  writePersonaTemplate(dir, opts.personaId, t);
  process.stdout.write(`[persona add] ${opts.personaId} written. Use in: provision_worker('${opts.personaId}', ...)\n`);
}
