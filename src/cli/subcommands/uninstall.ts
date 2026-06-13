/** P-38: `mai uninstall` — remove the global mai install. fs-only (no child_process).
 *  --purge also removes ~/.frondose/ (credentials, sessions, the Chrome-profile symlink). */
import { existsSync, lstatSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { confirm } from "@inquirer/prompts";
import { DATA_DIR_NAME, getHomeBase } from "../../persistence/paths.js";
import { derivePackageSymlink, isDevLink } from "../autoUpdate.js";

export interface UninstallOpts {
  purge: boolean;
  yes: boolean;
  /** DI for tests — default process.argv[1]. */
  argv1?: string;
  /** DI for tests — default getHomeBase(). */
  homeDir?: string;
  /** DI for tests — default the @inquirer/prompts confirm. */
  confirm?: (message: string) => Promise<boolean>;
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Remove a path that may be a symlink (unlink) or a real dir (recursive rm). */
function removePathSafe(p: string): void {
  if (!existsSync(p) && !isLink(p)) return;
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink() || st.isFile()) unlinkSync(p);
    else rmSync(p, { recursive: true, force: true });
  } catch {
    // best-effort — ENOENT / already-gone is fine
  }
}

export async function runUninstallSubcommand(opts: UninstallOpts): Promise<void> {
  const argv1 = opts.argv1 ?? process.argv[1] ?? "";
  const home = opts.homeDir ?? getHomeBase();
  const ask = opts.confirm ?? ((m: string) => confirm({ message: m }));

  const pkgSymlink = derivePackageSymlink(argv1);
  if (!pkgSymlink) {
    process.stdout.write(
      "[uninstall] Not a global install (mai is not on the npm-global symlink path); nothing to remove.\n",
    );
    return;
  }
  const releasesDir = join(home, DATA_DIR_NAME, "agent", "releases");
  const maiDir = join(home, DATA_DIR_NAME);
  const devLink = isDevLink(pkgSymlink);

  if (!opts.yes) {
    process.stdout.write(
      "[uninstall] This removes the `mai` bin symlink, the package symlink, and the release dirs " +
        `(${releasesDir}).\n  Your ~/.frondose/ state (credentials, sessions, Chrome profile) is PRESERVED ` +
        "unless you also pass --purge.\n" +
        "  If a launchd `mai server` or Telegram daemon is running, run `mai server uninstall` " +
        "and/or `mai telegram off` FIRST — uninstall removes the binary out from under them.\n" +
        (devLink
          ? "  Note: this is a dev-link install — only the symlink is removed; your git checkout is untouched.\n"
          : ""),
    );
    if (!(await ask("Proceed with uninstall?"))) {
      process.stdout.write("[uninstall] Aborted — nothing removed.\n");
      return;
    }
  }

  removePathSafe(argv1); // the bin symlink (e.g. /opt/homebrew/bin/mai)
  removePathSafe(pkgSymlink); // the @kyoube/mai-agent package symlink (dev-link: symlink only)
  removePathSafe(releasesDir); // ~/.frondose/agent/releases/
  process.stdout.write("[uninstall] Removed the mai binary + release dirs.\n");

  if (opts.purge) {
    if (!opts.yes) {
      process.stdout.write(
        `[uninstall] --purge will DELETE ${maiDir} IN FULL and IRREVERSIBLY:\n` +
          "  • all credentials — ~/.frondose/agent/secrets.json (LLM keys, GitHub PAT, tokens)\n" +
          "  • all sessions, identity, soul, memory.sqlite, audit logs\n" +
          "  • the ~/.frondose/agent/chrome-profile SYMLINK → the SHARED mai-browser Chrome profile.\n" +
          "    (The symlink is removed; the underlying mai-browser profile dir is NOT deleted —\n" +
          "     but `mai` loses its logged-in LinkedIn/Chrome session.)\n",
      );
      if (!(await ask(`Permanently delete ${maiDir}?`))) {
        process.stdout.write("[uninstall] --purge aborted — ~/.frondose/ kept.\n");
        return;
      }
    }
    removePathSafe(maiDir);
    process.stdout.write(`[uninstall] Purged ${maiDir}.\n`);
  }
  process.stdout.write("[uninstall] mai uninstalled.\n");
}
