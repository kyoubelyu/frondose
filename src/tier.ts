import { frondoseEnv } from "./env.js";

export type MaiTier = "consumer" | "power";

export function resolveTier(env: NodeJS.ProcessEnv = process.env): MaiTier {
  return frondoseEnv("TIER", env) === "power" ? "power" : "consumer";
}
