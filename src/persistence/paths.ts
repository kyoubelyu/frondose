import { homedir } from "node:os";
import { frondoseEnv } from "../env.js";

export { DATA_DIR_NAME } from "./dataDirMigration.js";

export function getHomeBase(): string {
  const raw = frondoseEnv("HOME_BASE");
  return raw && raw.trim() !== "" ? raw : homedir();
}
