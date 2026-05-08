import type { ToolSet } from "ai";
import { makeGetIdentityTool } from "./getIdentity.js";
import { makeIdentityTool } from "./identity.js";

export function makeIdentityTools(identityPath: string): ToolSet {
  return {
    identity: makeIdentityTool(identityPath),
    getIdentity: makeGetIdentityTool(identityPath),
  };
}
