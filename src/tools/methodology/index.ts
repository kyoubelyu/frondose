import type { ToolSet } from "ai";
import { makeQualifyProfileTool } from "./qualifyProfile.js";

interface MethodologyToolsOpts {
  configPath: string;
}

export function makeMethodologyTools(opts: MethodologyToolsOpts): ToolSet {
  return {
    qualify_profile: makeQualifyProfileTool({ configPath: opts.configPath }),
  };
}
