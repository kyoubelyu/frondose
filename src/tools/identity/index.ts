import type { ToolSet } from "ai";
import { makeGetIdentityTool } from "./getIdentity.js";
import { makeIdentityTool } from "./identity.js";

export function makeIdentityTools(configPath: string): ToolSet {
  return {
    identity: makeIdentityTool(configPath),
    getIdentity: makeGetIdentityTool(configPath),
  };
}
