import { modeFromState } from "../../../tauri/ui/mode.js";
import type { ServeDeps, ServeState } from "../context.js";

/** P-AUTO-8 (M1): pick the per-turn system prompt.
 *  workflow-resume → deps.systemResume (baked mode, stable across the workflow);
 *  cron → deps.system (band-only; cron.ts:107 carries the Auto fragment in the PROMPT);
 *  operator → deps.composeOperatorSystem(liveMode) (fresh mode fragment INSIDE Soul, so a
 *  Tauri Auto/Manual toggle takes effect without a sidecar restart). */
export function selectSystemForTurn(
  args: { isWorkflowResume?: boolean; isCronTurn?: boolean },
  state: ServeState,
  deps: ServeDeps,
): string {
  if (args.isWorkflowResume) return deps.systemResume;
  if (args.isCronTurn) return deps.system;
  return deps.composeOperatorSystem(
    modeFromState({ cronEnabled: state.cronEnabled, passiveEnabled: state.passiveEnabled }),
  );
}
