import { existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { DEFAULT_IDENTITY_PATH, readIdentity } from "../../persistence/identity.js";
import { runIdentityBootstrap } from "../identity-init.js";

export interface IdentitySubcommandOpts {
  identityPath?: string;
  reset?: boolean;
}

export async function runIdentitySubcommand(action: "init" | "show", opts: IdentitySubcommandOpts): Promise<void> {
  const identityPath = opts.identityPath ?? DEFAULT_IDENTITY_PATH();
  const wipPath = join(dirname(identityPath), ".identity-wip.json");

  if (action === "show") {
    const record = readIdentity(identityPath);
    if (!record) {
      process.stdout.write("No identity found. Run `mai identity init` to set up.\n");
      return;
    }
    process.stdout.write(`identity.json (${identityPath})\n\n`);
    process.stdout.write(JSON.stringify(record, null, 2));
    process.stdout.write("\n");
    return;
  }

  // action === "init"
  if (opts.reset) {
    // One-question static readline — safe before bootstrap-agent because bootstrap isn't running yet.
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer: string = await new Promise((resolve) =>
      rl.question("Identity exists. Delete and restart from scratch? [y/N]: ", (a) => {
        rl.close();
        resolve(a.trim());
      }),
    );
    if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
      process.stdout.write("[mai] Cancelled.\n");
      return;
    }
    if (existsSync(wipPath)) unlinkSync(wipPath);
    if (existsSync(identityPath)) unlinkSync(identityPath);
  }

  // Resume-by-default OR after --reset (cleared above): runIdentityBootstrap
  // delegates to runBootstrapAgent after detectAnyModelKey guard.
  await runIdentityBootstrap(identityPath);
}
