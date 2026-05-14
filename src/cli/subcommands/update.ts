import { createRequire } from "node:module";
import { readGithubConfig } from "../../persistence/github.js";

const require = createRequire(import.meta.url);
const pkg = require("../../../package.json") as { version: string };

export interface UpdateSubcommandOpts {
  /** Output machine-readable JSON to stdout. Default false. */
  json?: boolean;
  /** DI: fetch implementation (tests inject a mock). Defaults to globalThis.fetch. */
  fetchImpl?: typeof globalThis.fetch;
  /** DI: path to github.json for token resolution (tests inject temp path). */
  cfgPath?: string;
  /** DI: local version string (tests inject to simulate different versions). */
  localVersion?: string;
}

export interface UpdateResult {
  current: string;
  updateAvailable: boolean;
  latest?: string;
  publishedAt?: string;
  htmlUrl?: string;
  ahead?: boolean;
  error?: "no_token" | "unauthorized" | "not_found" | "network" | "unknown";
  message?: string;
}

/**
 * Compare two semver strings (with or without leading "v").
 * Assumes strict `{v}major.minor.patch` format.
 * @returns -1 if a < b, 0 if equal, 1 if a > b
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1;
  }
  return 0;
}

export async function runUpdateSubcommand(opts: UpdateSubcommandOpts = {}): Promise<void> {
  const fetch = opts.fetchImpl ?? globalThis.fetch;
  const localVersion = opts.localVersion ?? pkg.version;
  const localWithV = `v${localVersion.replace(/^v/, "")}`;

  // 1. Resolve token
  const ghCfg = readGithubConfig(opts.cfgPath);
  const token = process.env.GH_TOKEN ?? ghCfg.token;

  // 2. No token → guidance (no network call)
  if (!token) {
    if (opts.json) {
      const result: UpdateResult = {
        current: localWithV,
        updateAvailable: false,
        error: "no_token",
        message:
          "GitHub token not configured — cannot check private repo. Run `mai gh set --token <PAT>` to enable update checks.",
      };
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      process.stdout.write("GitHub token not configured — cannot check private repo.\n");
      process.stdout.write("Run `mai gh set --token <PAT>` to enable update checks.\n");
    }
    return;
  }

  // 3. Fetch latest release
  let release: { tag_name: string; published_at: string; html_url: string };
  try {
    const resp = await fetch("https://api.github.com/repos/kyoubelyu/mai-agent/releases/latest", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      if (resp.status === 401) {
        throw Object.assign(new Error("GitHub token invalid"), { code: 401 });
      }
      if (resp.status === 404) {
        throw Object.assign(new Error("Release not found"), { code: 404 });
      }
      throw Object.assign(new Error(`GitHub API error: HTTP ${resp.status}`), { code: resp.status });
    }

    const body = (await resp.json()) as { tag_name: string; published_at: string; html_url: string };
    release = body;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: number }).code;
    let error: UpdateResult["error"] = "unknown";
    if (code === 401) error = "unauthorized";
    else if (code === 404) error = "not_found";
    else if (err instanceof DOMException && err.name === "AbortError") error = "network";
    else if (!code) error = "network";

    if (opts.json) {
      const result: UpdateResult = { current: localWithV, updateAvailable: false, error, message };
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      process.stdout.write(`Error checking for updates: ${message}\n`);
      if (error === "unauthorized") {
        process.stdout.write("Run `mai gh set --token <PAT>` to reconfigure your token.\n");
      }
    }
    return;
  }

  // 4. Compare versions
  const latestVersion = release.tag_name.replace(/^v/, "");
  const latestWithV = `v${latestVersion}`;
  const cmp = compareVersions(localVersion, latestVersion);

  const result: UpdateResult = {
    current: localWithV,
    latest: latestWithV,
    updateAvailable: cmp === -1,
    publishedAt: release.published_at,
    htmlUrl: release.html_url,
  };
  if (cmp === 1) result.ahead = true;

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  // Human-readable output
  process.stdout.write(`Current:  ${localWithV}\n`);
  process.stdout.write(`Latest:   ${latestWithV}  (published ${release.published_at.split("T")[0]})\n`);
  if (cmp === -1) {
    process.stdout.write("\n");
    process.stdout.write("Update available! Run `npm install -g @kyoube/mai-agent` to upgrade.\n");
  } else if (cmp === 1) {
    process.stdout.write("Local build is ahead of latest release.\n");
  } else {
    process.stdout.write("Up to date.\n");
  }
}
