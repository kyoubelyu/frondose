import { homedir } from "node:os";

export function getHomeBase(): string {
  const raw = process.env.MAI_HOME_BASE;
  return raw && raw.trim() !== "" ? raw : homedir();
}
