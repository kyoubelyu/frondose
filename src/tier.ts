export type MaiTier = "consumer" | "power";

export function resolveTier(env: NodeJS.ProcessEnv = process.env): MaiTier {
  return env.MAI_TIER === "power" ? "power" : "consumer";
}
