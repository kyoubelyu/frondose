import { createInterface } from "node:readline";
import {
  type IdentityFieldName,
  type IdentityRecord,
  identityRecordSchema,
  writeIdentity,
} from "../persistence/identity.js";

interface FieldSpec {
  name: IdentityFieldName;
  prompt: string;
  required: boolean;
}

const FIELD_SPECS: FieldSpec[] = [
  { name: "fullName", prompt: "Your full name", required: true },
  { name: "profileUrl", prompt: "Your LinkedIn profile URL", required: false },
  { name: "persona", prompt: "Your persona (a short self-description, e.g. 'Founder & engineer')", required: false },
  { name: "company", prompt: "Your company name", required: true },
  { name: "role", prompt: "Your role/title", required: false },
  { name: "contact", prompt: "Your contact info (email, phone, etc.)", required: false },
  { name: "style", prompt: "Your communication style (e.g. 'Direct, technical, kind')", required: false },
];

/**
 * Run the first-run identity bootstrap. Prompts the operator via stdin, saves to identityPath,
 * returns the saved record. Throws on EOF/abort. Pure readline; no LLM dependency.
 */
export async function runIdentityBootstrap(identityPath: string): Promise<IdentityRecord> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Per guardian critic NIT-2: remove the close-listener on each successful answer to prevent
  // listener-accumulation across the 8 prompts (default EventEmitter cap is 10).
  const ask = (q: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const onClose = () => reject(new Error("identity bootstrap aborted (EOF)"));
      rl.once("close", onClose);
      rl.question(q, (answer) => {
        rl.removeListener("close", onClose);
        resolve(answer);
      });
    });

  process.stdout.write("\n=== mai-agent first-run identity bootstrap ===\n");
  process.stdout.write("Press Enter to skip optional fields.\n\n");

  const collected: Partial<IdentityRecord> = {};
  try {
    for (const spec of FIELD_SPECS) {
      while (true) {
        const answer = (await ask(`${spec.prompt}: `)).trim();
        if (!answer) {
          if (spec.required) {
            process.stdout.write(`  → ${spec.name} is required. Please enter a value.\n`);
            continue;
          }
          break; // skip optional
        }
        // For profileUrl, validate URL shape; for others, accept any non-empty trimmed value.
        if (spec.name === "profileUrl") {
          try {
            new URL(answer);
          } catch {
            process.stdout.write("  → invalid URL. Please enter a full URL or press Enter to skip.\n");
            continue;
          }
        }
        (collected as Record<string, unknown>)[spec.name] = answer;
        break;
      }
    }
    // Optional ICP target roles.
    const icpAnswer = (await ask("ICP target roles (comma-separated, or press Enter to skip): ")).trim();
    if (icpAnswer) {
      const targetRole = icpAnswer
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (targetRole.length > 0) {
        collected.icp = { targetRole };
      }
    }
  } finally {
    rl.close();
  }

  const record = identityRecordSchema.parse({
    ...collected,
    updatedAt: new Date().toISOString(),
  });
  writeIdentity(record, identityPath);
  process.stdout.write(`\nIdentity saved to ${identityPath}.\n\n`);
  return record;
}
