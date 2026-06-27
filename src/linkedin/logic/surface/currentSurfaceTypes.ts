import type {
  ActiveLayer,
  InspectSummary,
  VisibleScopeControl,
  VisibleScopeInspection,
  VisibleScopeSummary,
} from "../contracts/inspect.js";
import type { SnapshotEntry as FrondoseSnapshotEntry } from "../../types.js";

export interface SnapshotRef {
  name?: string;
  role?: string;
  selector?: string;
}

export type SnapshotEntry = FrondoseSnapshotEntry & {
  selector?: string;
  value?: string;
};

export interface RuntimeVisibleScopeControl extends VisibleScopeControl {
  selectorRef?: string;
}

export interface RuntimeVisibleScopeInspection extends Omit<VisibleScopeInspection, "scope" | "controls"> {
  scope: Omit<VisibleScopeSummary, "controls"> & {
    controls: RuntimeVisibleScopeControl[];
  };
  controls: RuntimeVisibleScopeControl[];
}

export interface CurrentSurfaceContext {
  pageUrl: string;
  surface: string;
  activeLayer: ActiveLayer;
  entries: SnapshotEntry[];
  repeatedControls: string[];
  summary: InspectSummary;
  visibleScopeInspections?: RuntimeVisibleScopeInspection[];
}
