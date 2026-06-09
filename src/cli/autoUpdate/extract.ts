import { type SpawnSyncReturns, spawnSync } from "node:child_process";

// §6.3: extractTarball + buildRelease ────────────────────────────────────────

export function extractTarball(tgzPath: string, destDir: string, spawn: typeof spawnSync): SpawnSyncReturns<Buffer> {
  return spawn("tar", ["-xzf", tgzPath, "-C", destDir, "--strip-components=1"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function buildRelease(
  releaseDir: string,
  spawn: typeof spawnSync,
  step: "install" | "build",
): SpawnSyncReturns<Buffer> {
  const args = step === "install" ? ["install", "--prefer-offline"] : ["run", "build"];
  return spawn("npm", args, {
    cwd: releaseDir,
    stdio: ["ignore", "inherit", "inherit"], // operator sees progress
    env: process.env,
  });
}
