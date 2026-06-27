import { z } from "zod";
import { methodologyBlockSchema, type MethodologyBlock } from "./methodology.js";
import { MINIMAL_PUBLIC_SCOPE_IDS, type MinimalPublicScopeId } from "./minimalPublicContract.js";
import { visibleScopeKindSchema, type VisibleScopeKind } from "./visibleScope.js";

export const activeLayerSchema = z.enum(["page", "modal", "thread"]);
export type ActiveLayer = z.infer<typeof activeLayerSchema>;

const minimalPublicScopeIdSchema = z.enum(MINIMAL_PUBLIC_SCOPE_IDS);

export interface InspectScope {
  id: MinimalPublicScopeId;
  label: string;
  parent?: MinimalPublicScopeId;
}

export interface InteractiveRegion {
  id: string;
  label: string;
  scope: MinimalPublicScopeId;
  controls: string[];
}

export interface AmbiguityCase {
  label: string;
  anchorScope: MinimalPublicScopeId;
  repeatedLabels: string[];
}

export interface VisibleScopeControl {
  label: string;
  role: string;
  ref?: string;
  value?: string;
}

export interface VisibleScopeSummary {
  handle: string;
  kind: VisibleScopeKind;
  label: string;
  parent?: string;
  anchorRef?: string;
  previewText: string[];
  buttons: string[];
  inputs: string[];
  inputValues?: string[];
  controls: VisibleScopeControl[];
  methodology?: MethodologyBlock;
  authorProfileUrl?: string;
}

export interface InspectSummary {
  surface: string;
  activeLayer: ActiveLayer;
  availableScopes: InspectScope[];
  text: string[];
  buttons: string[];
  inputs: string[];
  inputValues?: string[];
  interactiveRegions: InteractiveRegion[];
  ambiguityCases: AmbiguityCase[];
  visibleScopes?: VisibleScopeSummary[];
}

export interface ScopeInspection {
  scope: InspectScope;
  text: string[];
  buttons: string[];
  inputs: string[];
  inputValues?: string[];
  interactiveRegions: InteractiveRegion[];
  ambiguityCases: AmbiguityCase[];
}

export interface VisibleScopeInspection {
  scope: VisibleScopeSummary;
  text: string[];
  buttons: string[];
  inputs: string[];
  inputValues?: string[];
  controls: VisibleScopeControl[];
}

export const inspectScopeSchema: z.ZodType<InspectScope> = z.object({
  id: minimalPublicScopeIdSchema,
  label: z.string().min(1),
  parent: minimalPublicScopeIdSchema.optional(),
});

export const interactiveRegionSchema: z.ZodType<InteractiveRegion> = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  scope: minimalPublicScopeIdSchema,
  controls: z.array(z.string()),
});

export const ambiguityCaseSchema: z.ZodType<AmbiguityCase> = z.object({
  label: z.string().min(1),
  anchorScope: minimalPublicScopeIdSchema,
  repeatedLabels: z.array(z.string()).min(1),
});

export const visibleScopeControlSchema: z.ZodType<VisibleScopeControl> = z.object({
  label: z.string().min(1),
  role: z.string().min(1),
  ref: z.string().min(1).optional(),
  value: z.string().optional(),
});

export const visibleScopeSummarySchema: z.ZodType<VisibleScopeSummary> = z.object({
  handle: z.string().min(1),
  kind: visibleScopeKindSchema,
  label: z.string().min(1),
  parent: z.string().min(1).optional(),
  anchorRef: z.string().min(1).optional(),
  previewText: z.array(z.string()),
  buttons: z.array(z.string()),
  inputs: z.array(z.string()),
  inputValues: z.array(z.string()).optional(),
  controls: z.array(visibleScopeControlSchema),
  methodology: methodologyBlockSchema.optional(),
  authorProfileUrl: z.string().optional(),
});

export const inspectSummarySchema: z.ZodType<InspectSummary> = z.object({
  surface: z.string().min(1),
  activeLayer: activeLayerSchema,
  availableScopes: z.array(inspectScopeSchema).min(1),
  text: z.array(z.string()),
  buttons: z.array(z.string()),
  inputs: z.array(z.string()),
  inputValues: z.array(z.string()).optional(),
  interactiveRegions: z.array(interactiveRegionSchema),
  ambiguityCases: z.array(ambiguityCaseSchema),
  visibleScopes: z.array(visibleScopeSummarySchema).optional(),
});

export const scopeInspectionSchema: z.ZodType<ScopeInspection> = z.object({
  scope: inspectScopeSchema,
  text: z.array(z.string()),
  buttons: z.array(z.string()),
  inputs: z.array(z.string()),
  inputValues: z.array(z.string()).optional(),
  interactiveRegions: z.array(interactiveRegionSchema),
  ambiguityCases: z.array(ambiguityCaseSchema),
});

export const visibleScopeInspectionSchema: z.ZodType<VisibleScopeInspection> = z.object({
  scope: visibleScopeSummarySchema,
  text: z.array(z.string()),
  buttons: z.array(z.string()),
  inputs: z.array(z.string()),
  inputValues: z.array(z.string()).optional(),
  controls: z.array(visibleScopeControlSchema),
});
