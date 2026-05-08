import type { ToolSet } from "ai";
import { makeQualifyProfileTool } from "./qualifyProfile.js";

interface MethodologyToolsOpts {
  identityPath: string;
}

export function makeMethodologyTools(opts: MethodologyToolsOpts): ToolSet {
  return {
    qualify_profile: makeQualifyProfileTool({ identityPath: opts.identityPath }),
  };
}
