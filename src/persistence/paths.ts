import { homedir } from "node:os";
import { frondoseEnv } from "../env.js";

export const DATA_DIR_NAME = ".frondose";

export function getHomeBase(): string {
  const raw = frondoseEnv("HOME_BASE");
  return raw && raw.trim() !== "" ? raw : homedir();
}
