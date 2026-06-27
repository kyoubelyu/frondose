import type { CdpClient } from "../../../cdp/client.js";
import { findVisibleScopeInspection } from "../contracts/visibleScope.js";
import type {
  CurrentSurfaceContext,
  RuntimeVisibleScopeControl,
  RuntimeVisibleScopeInspection,
  SnapshotEntry,
} from "./currentSurfaceTypes.js";

export const MEDIA_EDITOR_THUMBNAIL_UPLOAD_LABEL = "Add video thumbnail";
export const MEDIA_EDITOR_THUMBNAIL_REMOVE_LABEL = "Remove video thumbnail";
export const MEDIA_EDITOR_THUMBNAIL_UPLOAD_HINT =
  'Add video thumbnail is a file upload control. Upload an image through the thumbnail upload flow, then click `"Add"` to commit the thumbnail before clicking `"Back"`.';

function hasExactEntryName(entry: SnapshotEntry, label: string): boolean {
  return entry.name.trim().toLowerCase() === label.toLowerCase();
}

function hasExactControlLabel(control: RuntimeVisibleScopeControl, label: string): boolean {
  return control.label.trim().toLowerCase() === label.toLowerCase();
}

export function isMediaEditorThumbnailUploadLabel(label: string | undefined): boolean {
  return Boolean(label && label.trim().toLowerCase() === MEDIA_EDITOR_THUMBNAIL_UPLOAD_LABEL.toLowerCase());
}

export function isMediaEditorThumbnailActionEntry(entry: SnapshotEntry): boolean {
  return (
    entry.role === "button" &&
    (hasExactEntryName(entry, MEDIA_EDITOR_THUMBNAIL_UPLOAD_LABEL) ||
      hasExactEntryName(entry, MEDIA_EDITOR_THUMBNAIL_REMOVE_LABEL))
  );
}

export function hasMediaEditorThumbnailSurfaceSignals(entries: SnapshotEntry[]): boolean {
  const hasDismiss = entries.some((entry) => entry.role === "button" && hasExactEntryName(entry, "Dismiss"));
  const hasBack = entries.some((entry) => entry.role === "button" && hasExactEntryName(entry, "Back"));
  const hasAdd = entries.some((entry) => entry.role === "button" && hasExactEntryName(entry, "Add"));
  const hasThumbnailAction = entries.some((entry) => isMediaEditorThumbnailActionEntry(entry));
  return hasDismiss && hasBack && hasAdd && hasThumbnailAction;
}

function parseEvalJson<T>(stdout: string): T | null {
  if (!stdout) {
    return null;
  }

  try {
    const parsed = JSON.parse(stdout) as T | string;
    return typeof parsed === "string" ? (JSON.parse(parsed) as T) : parsed;
  } catch {
    return null;
  }
}

export async function extractMediaEditorThumbnailInputEntry(client: CdpClient, entries: SnapshotEntry[]): Promise<SnapshotEntry | null> {
  if (!hasMediaEditorThumbnailSurfaceSignals(entries)) {
    return null;
  }

  let stdout: string;
  try {
    stdout = await client.evaluate<string>(`(() => {
        const label = ${JSON.stringify(MEDIA_EDITOR_THUMBNAIL_UPLOAD_LABEL)};
        const input = document.querySelector('input[type="file"][aria-label="Add video thumbnail"]');
        if (!(input instanceof HTMLInputElement)) {
          return JSON.stringify(null);
        }

        const accept = input.getAttribute("accept") || "";
        if (!/image\\/(gif|jpeg|jpg|png|webp)/i.test(accept)) {
          return JSON.stringify(null);
        }

        const id = input.id || "";
        const className = String(input.getAttribute("class") || "");
        if (id !== "media-editor-video-thumbnail-selector__file-input" && !className.includes("media-editor-video-thumbnail-selector")) {
          return JSON.stringify(null);
        }

        const selector = id ? "#" + CSS.escape(id) : 'input[type="file"][aria-label="Add video thumbnail"]';
        return JSON.stringify({
          ref: id ? "dom#" + id : "dom#media-editor-video-thumbnail-selector",
          role: "file-input",
          name: label,
          selector
        });
      })()`);
  } catch {
    return null;
  }

  const parsed = parseEvalJson<SnapshotEntry | null>(stdout);
  if (
    !parsed ||
    Array.isArray(parsed) ||
    parsed.role !== "file-input" ||
    parsed.name !== MEDIA_EDITOR_THUMBNAIL_UPLOAD_LABEL ||
    !parsed.selector
  ) {
    return null;
  }

  return parsed;
}

export function mergeMediaEditorThumbnailInputEntry(
  entries: SnapshotEntry[],
  thumbnailInput: SnapshotEntry | null,
): SnapshotEntry[] {
  if (!thumbnailInput) {
    return entries;
  }

  let replaced = false;
  const merged = entries.map((entry) => {
    if (!hasExactEntryName(entry, MEDIA_EDITOR_THUMBNAIL_UPLOAD_LABEL)) {
      return entry;
    }

    replaced = true;
    return thumbnailInput;
  });

  return replaced ? merged : [...merged, thumbnailInput];
}

function isMediaEditorThumbnailScope(
  inspection: RuntimeVisibleScopeInspection,
  requestedScope: string | undefined,
): boolean {
  if (!requestedScope) {
    return inspection.scope.handle === "modal" || inspection.scope.kind === "composerMedia";
  }

  return inspection.scope.handle === requestedScope || inspection.scope.kind === requestedScope;
}

function findThumbnailUploadScope(
  context: CurrentSurfaceContext,
  requestedScope: string | undefined,
): RuntimeVisibleScopeInspection | undefined {
  if (requestedScope) {
    const inspection = findVisibleScopeInspection(context.visibleScopeInspections, requestedScope);
    return inspection && isMediaEditorThumbnailScope(inspection, requestedScope) ? inspection : undefined;
  }

  return context.visibleScopeInspections?.find((inspection) => isMediaEditorThumbnailScope(inspection, undefined));
}

export interface MediaEditorThumbnailUploadTarget {
  selector: string;
  ref?: string;
  label: string;
  role: string;
  scope: string;
}

export function resolveMediaEditorThumbnailUploadTarget(
  context: CurrentSurfaceContext,
  requestedScope: string | undefined,
  label: string | undefined,
  ref: string | undefined,
): MediaEditorThumbnailUploadTarget | null {
  if (context.surface !== "composer-media-modal" || (!label && !ref)) {
    return null;
  }

  const scope = findThumbnailUploadScope(context, requestedScope);
  if (!scope) {
    return null;
  }

  let controls = scope.controls.filter(
    (control) => control.role === "file-input" && hasExactControlLabel(control, MEDIA_EDITOR_THUMBNAIL_UPLOAD_LABEL),
  );

  if (label) {
    controls = controls.filter((control) => hasExactControlLabel(control, label));
  }

  if (ref) {
    controls = controls.filter((control) => control.ref === ref || control.selectorRef === ref);
  }

  const control = controls[0];
  if (!control?.selectorRef) {
    return null;
  }

  return {
    selector: control.selectorRef,
    ...(control.ref ? { ref: control.ref } : {}),
    label: control.label,
    role: control.role,
    scope: scope.scope.handle,
  };
}
