import { writeFileSync } from "node:fs";

const REPO_PATH = "kyoubelyu/frondose";
const LATEST_URL = `https://api.github.com/repos/${REPO_PATH}/releases/latest`;
const RELEASES_LIST_URL = `https://api.github.com/repos/${REPO_PATH}/releases?per_page=30`;

// §6.2: fetchLatestTag + downloadTarball ─────────────────────────────────────

export async function fetchLatestTag(
  fetchFn: typeof globalThis.fetch,
  token: string,
): Promise<{ tag_name: string; tarball_url: string }> {
  const resp = await fetchFn(LATEST_URL, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json() as Promise<{ tag_name: string; tarball_url: string }>;
}

export async function fetchLatestPrerelease(
  fetchFn: typeof globalThis.fetch,
  token: string,
): Promise<{ tag_name: string; tarball_url: string }> {
  const resp = await fetchFn(RELEASES_LIST_URL, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const all = (await resp.json()) as Array<{
    tag_name: string;
    tarball_url: string;
    prerelease: boolean;
    draft: boolean;
    published_at: string;
  }>;
  const pres = all
    .filter((r) => r.prerelease && !r.draft)
    .sort((x, y) => (x.published_at < y.published_at ? 1 : x.published_at > y.published_at ? -1 : 0));
  const latest = pres[0];
  if (latest === undefined) throw new Error("no prerelease found");
  return { tag_name: latest.tag_name, tarball_url: latest.tarball_url };
}

export async function downloadTarball(
  tarballUrl: string,
  destPath: string,
  fetchFn: typeof globalThis.fetch,
  token: string,
): Promise<void> {
  // GitHub redirects to codeload / S3; per WHATWG Fetch §4.3.12 auth headers
  // are stripped on cross-origin redirect (Node 24 undici complies).
  const resp = await fetchFn(tarballUrl, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(60_000),
    redirect: "follow",
  });
  if (!resp.ok) throw new Error(`tarball HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  writeFileSync(destPath, buf);
}
