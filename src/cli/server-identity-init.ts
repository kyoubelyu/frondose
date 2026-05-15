/** P-25: interactive prompts for `mai server identity init`.
 *  Mirrors src/cli/identity-init.ts but for the orchestrator persona schema.
 *  Auto-suggests operatorName / operatorRole / operatorCompany from worker
 *  identity if present; never overwrites without --reset flag. */
import { existsSync, readFileSync } from "node:fs";
import type { ServerIdentity } from "../persistence/serverIdentity.js";
import { writeServerIdentity } from "../persistence/serverIdentity.js";
import type { Prompter } from "./subcommands/_prompts.js";

interface WorkerIdentityRaw {
  fullName?: string;
  role?: string;
  company?: string;
}

function readWorkerIdentityRaw(workerIdentityPath: string): WorkerIdentityRaw | null {
  if (!existsSync(workerIdentityPath)) return null;
  try {
    return JSON.parse(readFileSync(workerIdentityPath, "utf-8")) as WorkerIdentityRaw;
  } catch {
    return null;
  }
}

export interface ServerIdentityInitOpts {
  serverIdentityPath: string;
  workerIdentityPath: string;
  reset: boolean;
}

/** Run the interactive server identity init flow.
 *  Returns the written ServerIdentity on success; returns null if user cancels. */
export async function runServerIdentityInit(
  opts: ServerIdentityInitOpts,
  prompter: Prompter,
): Promise<ServerIdentity | null> {
  if (existsSync(opts.serverIdentityPath) && !opts.reset) {
    process.stdout.write("Server identity already exists. Use --reset to start over.\n");
    return null;
  }

  const worker = readWorkerIdentityRaw(opts.workerIdentityPath);

  process.stdout.write("\n=== mai server identity init ===\n");
  process.stdout.write("Configure the orchestrator agent's persona. (Ctrl-C to cancel)\n\n");

  // operatorName — auto-suggest from worker identity
  const suggestedName = worker?.fullName ?? "";
  const operatorName =
    (await prompter.input(suggestedName ? `Operator name [${suggestedName}]: ` : "Operator name: ")).trim() ||
    suggestedName;
  if (!operatorName) {
    process.stderr.write("[server identity init] operator name is required\n");
    return null;
  }

  const suggestedRole = worker?.role ?? "";
  const operatorRoleRaw =
    (
      await prompter.input(
        suggestedRole ? `Operator role (optional) [${suggestedRole}]: ` : "Operator role (optional): ",
      )
    ).trim() || suggestedRole;
  const operatorRole = operatorRoleRaw || undefined;

  const suggestedCompany = worker?.company ?? "";
  const operatorCompanyRaw =
    (
      await prompter.input(
        suggestedCompany ? `Operator company (optional) [${suggestedCompany}]: ` : "Operator company (optional): ",
      )
    ).trim() || suggestedCompany;
  const operatorCompany = operatorCompanyRaw || undefined;

  const orchestratorName = (await prompter.input("Orchestrator name [mai-server]: ")).trim() || "mai-server";
  const orchestratorRole =
    (await prompter.input("Orchestrator role [Operator's chief-of-staff agent]: ")).trim() ||
    "Operator's chief-of-staff agent";

  const identity: ServerIdentity = {
    operatorName,
    operatorRole,
    operatorCompany,
    orchestratorName,
    orchestratorRole,
    priorities: [],
    traits: [],
    updatedAt: new Date().toISOString(),
  };

  writeServerIdentity(identity, opts.serverIdentityPath);
  process.stdout.write(`\n[server identity] written to ${opts.serverIdentityPath}\n`);
  return identity;
}
