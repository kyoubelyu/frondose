import { createRequire } from "node:module";
import { frondoseEnv } from "../../env.js";
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
 * Compare two semver strings (with or without a leading "v"), INCLUDING
 * prerelease suffixes (e.g. "0.5.0-alpha.25"). Implements the SemVer §11
 * precedence rules this project's tags need:
 *   1. Compare major.minor.patch numerically.
 *   2. A version WITHOUT a prerelease outranks one WITH a prerelease at the same
 *      core (1.0.0 > 1.0.0-alpha.1).
 *   3. Two prereleases compare identifier-by-identifier: numeric identifiers
 *      numerically, others lexically; numeric < non-numeric; fewer ids = lower.
 * @returns -1 if a < b, 0 if equal, 1 if a > b
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const [coreA, preA] = splitVersion(a);
  const [coreB, preB] = splitVersion(b);
  for (let i = 0; i < 3; i++) {
    const x = coreA[i] ?? 0;
    const y = coreB[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  // Presence of a prerelease: a release outranks its prereleases.
  if (preA.length === 0 && preB.length === 0) return 0;
  if (preA.length === 0) return 1;
  if (preB.length === 0) return -1;
  const n = Math.max(preA.length, preB.length);
  for (let i = 0; i < n; i++) {
    const x = preA[i];
    const y = preB[i];
    if (x === undefined) return -1; // fewer identifiers = lower precedence
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const dx = Number(x);
      const dy = Number(y);
      if (dx > dy) return 1;
      if (dx < dy) return -1;
    } else if (xn) {
      return -1; // numeric identifiers rank below non-numeric
    } else if (yn) {
      return 1;
    } else {
      if (x > y) return 1;
      if (x < y) return -1;
    }
  }
  return 0;
}

/** Split "v1.2.3-alpha.4" -> [[1,2,3], ["alpha","4"]]. Non-numeric core parts -> 0. */
function splitVersion(v: string): [number[], string[]] {
  const clean = v.replace(/^v/, "").trim();
  const dashIdx = clean.indexOf("-");
  const core = dashIdx === -1 ? clean : clean.slice(0, dashIdx);
  const pre = dashIdx === -1 ? "" : clean.slice(dashIdx + 1);
  const coreNums = core.split(".").map((s) => {
    const num = Number(s);
    return Number.isFinite(num) ? num : 0;
  });
  const preIds = pre === "" ? [] : pre.split(".");
  return [coreNums, preIds];
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
    const resp = await fetch("https://api.github.com/repos/kyoubelyu/frondose/releases/latest", {
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
    // P-22 §3.3: context-aware message — auto-update is the default path; only
    // when FRONDOSE_AUTOUPDATE=skip do we point the operator at manual recovery.
    if (frondoseEnv("AUTOUPDATE") === "skip") {
      process.stdout.write(
        `Update available: ${latestWithV} — auto-update is disabled (FRONDOSE_AUTOUPDATE=skip). Run \`mai\` to apply, or unset FRONDOSE_AUTOUPDATE.\n`,
      );
    } else {
      process.stdout.write(`Update available: ${latestWithV} — mai will auto-update on next startup.\n`);
    }
  } else if (cmp === 1) {
    process.stdout.write("Local build is ahead of latest release.\n");
  } else {
    process.stdout.write("Up to date.\n");
  }
}
