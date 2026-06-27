import type { VisibleScopeInspection } from "../contracts/inspect.js";
import type { VisibleScopeKind } from "../contracts/visibleScope.js";
import type { RuntimeVisibleScopeControl, SnapshotEntry } from "./currentSurfaceTypes.js";
import type { ForegroundRouteBucket } from "./foregroundContext.js";
import {
  createVisibleScopeFromEntries,
  dedupeEntriesByRoleAndName,
  previewTextFromEntries,
  toVisibleScopeControls,
} from "./visibleScopeCommon.js";

type TrustedRegionRole =
  | "nav"
  | "header"
  | "actions"
  | "content"
  | "composer"
  | "search"
  | "list"
  | "detail"
  | "input"
  | "modal"
  | "leftRail";

interface TrustedVisibleScopeSpec {
  role: TrustedRegionRole;
  handle: string;
  kind: VisibleScopeKind;
  label: string;
  parent?: string;
}

type TrustedSingleContentRouteBucket = Extract<ForegroundRouteBucket, "search" | "network" | "notifications">;

interface TrustedSingleContentPageSpec {
  routeBucket: TrustedSingleContentRouteBucket;
  filters?: TrustedVisibleScopeSpec;
  content: TrustedVisibleScopeSpec;
}

export interface TrustedHeaderActionsContentPageSpec {
  surface: "profile" | "company";
  parent: "profileView" | "companyView";
  boundaryMatcher: (entry: SnapshotEntry) => boolean;
  header: TrustedVisibleScopeSpec;
  actions: TrustedVisibleScopeSpec;
  content: TrustedVisibleScopeSpec;
}

export interface TrustedHeaderActionsContentSegments {
  headerEntries: SnapshotEntry[];
  actionEntries: SnapshotEntry[];
  contentEntries: SnapshotEntry[];
}

const HEADER_ACTION_LABEL_PATTERN =
  /^(message|message with premium|connect|follow|more|request services|show all services|visit website|visit my website|invite to connect|pending|requested|open to|hire|save|subscribe|join)$/i;
const HEADER_ACTION_DYNAMIC_LABEL_PATTERNS = [
  /^invite .+ to connect$/i,
  /^follow .+$/i,
  /^message .+$/i,
  /^send a message to .+$/i,
];
const POST_SOCIAL_BUTTON_LABELS = /^(open reactions menu|comment|repost)$/i;
const POST_SOCIAL_LINK_LABELS = /^(open actor selection screen|send|comment)$/i;

function isTopNavEntry(entry: SnapshotEntry): boolean {
  const normalized = entry.name.trim().toLowerCase();
  return (
    normalized === "linkedin" ||
    normalized === "search" ||
    /\bhome\b/.test(normalized) ||
    /\bmy network\b/.test(normalized) ||
    /\bjobs\b/.test(normalized) ||
    /\bmessaging\b/.test(normalized) ||
    /\bnotifications\b/.test(normalized) ||
    normalized === "me" ||
    /\bme$/.test(normalized) ||
    normalized === "for business" ||
    /\bfor business\b/.test(normalized) ||
    /\bnew notifications\b/.test(normalized)
  );
}

function isHeaderActionEntry(entry: SnapshotEntry): boolean {
  if (!(entry.role === "button" || entry.role === "link")) {
    return false;
  }

  const label = entry.name.trim();
  return (
    HEADER_ACTION_LABEL_PATTERN.test(label) ||
    HEADER_ACTION_DYNAMIC_LABEL_PATTERNS.some((pattern) => pattern.test(label))
  );
}

function collectHeaderActionEntries(entries: SnapshotEntry[]): SnapshotEntry[] {
  return dedupeEntriesByRoleAndName(entries.filter((entry) => isHeaderActionEntry(entry)));
}

function isProfileSurfaceBoundaryEntry(entry: SnapshotEntry): boolean {
  return (entry.role === "radio" || entry.role === "checkbox") && /^(posts|comments|videos)$/i.test(entry.name);
}

function isCompanySurfaceBoundaryEntry(entry: SnapshotEntry): boolean {
  return entry.role === "button" && /^Open control menu for post by /i.test(entry.name);
}

function isSocialActionEntry(entry: SnapshotEntry): boolean {
  const name = entry.name.trim();
  if (entry.role === "button" && POST_SOCIAL_BUTTON_LABELS.test(name)) return true;
  if (entry.role === "link" && POST_SOCIAL_LINK_LABELS.test(name)) return true;
  return false;
}

const TOP_NAV_VISIBLE_SCOPE_SPEC: TrustedVisibleScopeSpec = {
  role: "nav",
  handle: "topNav",
  kind: "topNav",
  label: "Top navigation",
  parent: "page",
};

export const TRUSTED_SINGLE_CONTENT_PAGE_SPECS: Record<TrustedSingleContentRouteBucket, TrustedSingleContentPageSpec> =
  {
    search: {
      routeBucket: "search",
      filters: {
        role: "actions",
        handle: "searchFilters",
        kind: "searchFilters",
        label: "Search filters",
        parent: "searchResults",
      },
      content: {
        role: "content",
        handle: "searchResults",
        kind: "searchResults",
        label: "Search results",
        parent: "searchResults",
      },
    },
    network: {
      routeBucket: "network",
      content: {
        role: "content",
        handle: "network",
        kind: "networkView",
        label: "Network page",
        parent: "networkView",
      },
    },
    notifications: {
      routeBucket: "notifications",
      content: {
        role: "content",
        handle: "notifications",
        kind: "notifications",
        label: "Notifications page",
        parent: "notificationsView",
      },
    },
  };

const SEARCH_FILTER_LABELS = new Set([
  "Jobs",
  "Posts",
  "People",
  "Groups",
  "Companies",
  "Schools",
  "Courses",
  "Events",
  "Products",
  "Services",
]);

function isSearchFilterEntry(entry: SnapshotEntry): boolean {
  return entry.role === "button" && SEARCH_FILTER_LABELS.has(entry.name.trim());
}

export const TRUSTED_HEADER_ACTIONS_CONTENT_PAGE_SPECS: Record<
  TrustedHeaderActionsContentPageSpec["surface"],
  TrustedHeaderActionsContentPageSpec
> = {
  profile: {
    surface: "profile",
    parent: "profileView",
    boundaryMatcher: isProfileSurfaceBoundaryEntry,
    header: {
      role: "header",
      handle: "header",
      kind: "profileHeader",
      label: "Profile header",
      parent: "profileView",
    },
    actions: {
      role: "actions",
      handle: "actions",
      kind: "profileActions",
      label: "Profile actions",
      parent: "profileView",
    },
    content: {
      role: "content",
      handle: "content",
      kind: "profileContent",
      label: "Profile content",
      parent: "profileView",
    },
  },
  company: {
    surface: "company",
    parent: "companyView",
    boundaryMatcher: isCompanySurfaceBoundaryEntry,
    header: {
      role: "header",
      handle: "header",
      kind: "companyHeader",
      label: "Company header",
      parent: "companyView",
    },
    actions: {
      role: "actions",
      handle: "actions",
      kind: "companyActions",
      label: "Company actions",
      parent: "companyView",
    },
    content: {
      role: "content",
      handle: "content",
      kind: "companyContent",
      label: "Company content",
      parent: "companyView",
    },
  },
};

function appendTrustedVisibleScopeInspection(
  inspections: VisibleScopeInspection[],
  spec: TrustedVisibleScopeSpec,
  entries: SnapshotEntry[],
  text = previewTextFromEntries(entries),
): void {
  if (entries.length === 0) {
    return;
  }

  inspections.push(createVisibleScopeFromEntries(spec.handle, spec.kind, spec.label, spec.parent, entries, text));
}

function buildProfileContentScopeControls(
  handle: string,
  entries: readonly SnapshotEntry[],
): RuntimeVisibleScopeControl[] {
  const bodyEntries = entries.filter((entry) => !isSocialActionEntry(entry));
  const socialEntries = entries.filter((entry) => isSocialActionEntry(entry));
  const bodyControls = toVisibleScopeControls(handle, bodyEntries);
  const socialControls = toVisibleScopeControls(handle, socialEntries);
  return [...bodyControls, ...socialControls];
}

function leadingTopNavEndIndex(entries: SnapshotEntry[], topNavEntries: SnapshotEntry[]): number {
  const lastRef = topNavEntries.at(-1)?.ref;
  return lastRef !== undefined ? entries.findIndex((entry) => entry.ref === lastRef) : -1;
}

function trailingEntriesAfterLeadingTopNav(entries: SnapshotEntry[], topNavEntries: SnapshotEntry[]): SnapshotEntry[] {
  const topNavEndIndex = leadingTopNavEndIndex(entries, topNavEntries);
  return topNavEndIndex >= 0 ? entries.slice(topNavEndIndex + 1) : entries;
}

export function buildTrustedSingleContentPageVisibleScopeInspections(
  entries: SnapshotEntry[],
  topNavEntries: SnapshotEntry[],
  spec: TrustedSingleContentPageSpec,
): VisibleScopeInspection[] {
  const inspections: VisibleScopeInspection[] = [];
  const contentEntries = trailingEntriesAfterLeadingTopNav(entries, topNavEntries);
  const filterEntries = spec.filters
    ? dedupeEntriesByRoleAndName(contentEntries.filter((entry) => isSearchFilterEntry(entry)))
    : [];
  const filterRefs = new Set(filterEntries.map((entry) => entry.ref));

  appendTrustedVisibleScopeInspection(inspections, TOP_NAV_VISIBLE_SCOPE_SPEC, topNavEntries);
  if (spec.filters) {
    appendTrustedVisibleScopeInspection(inspections, spec.filters, filterEntries);
  }
  appendTrustedVisibleScopeInspection(
    inspections,
    spec.content,
    contentEntries.filter((entry) => !filterRefs.has(entry.ref)),
  );
  return inspections;
}

export function buildTrustedHeaderActionsContentVisibleScopeInspections(
  entries: SnapshotEntry[],
  topNavEntries: SnapshotEntry[],
  spec: TrustedHeaderActionsContentPageSpec,
): VisibleScopeInspection[] {
  const segments = splitTrustedHeaderActionsContentEntries(entries, topNavEntries, spec);
  const inspections: VisibleScopeInspection[] = [];
  appendTrustedVisibleScopeInspection(inspections, TOP_NAV_VISIBLE_SCOPE_SPEC, topNavEntries);
  appendTrustedVisibleScopeInspection(inspections, spec.header, segments.headerEntries);
  appendTrustedVisibleScopeInspection(inspections, spec.actions, segments.actionEntries);

  if (spec.surface === "profile" && segments.contentEntries.length > 0) {
    const prebuiltControls = buildProfileContentScopeControls(spec.content.handle, segments.contentEntries);
    inspections.push(
      createVisibleScopeFromEntries(
        spec.content.handle,
        spec.content.kind,
        spec.content.label,
        spec.content.parent,
        segments.contentEntries,
        previewTextFromEntries(segments.contentEntries),
        { prebuiltControls },
      ),
    );
  } else {
    appendTrustedVisibleScopeInspection(inspections, spec.content, segments.contentEntries);
  }

  return inspections;
}

export function splitTrustedHeaderActionsContentEntries(
  entries: SnapshotEntry[],
  topNavEntries: SnapshotEntry[],
  spec: TrustedHeaderActionsContentPageSpec,
): TrustedHeaderActionsContentSegments {
  const remainingEntries = trailingEntriesAfterLeadingTopNav(entries, topNavEntries);
  const boundaryIndex = remainingEntries.findIndex((entry) => spec.boundaryMatcher(entry));
  const rawHeaderEntries =
    boundaryIndex >= 0 ? remainingEntries.slice(0, boundaryIndex) : remainingEntries.slice(0, 24);
  const contentEntries =
    boundaryIndex >= 0 ? remainingEntries.slice(boundaryIndex) : remainingEntries.slice(rawHeaderEntries.length);
  const actionEntries = collectHeaderActionEntries(rawHeaderEntries);
  const headerEntries = dedupeEntriesByRoleAndName(rawHeaderEntries.filter((entry) => !isHeaderActionEntry(entry)));

  return {
    headerEntries,
    actionEntries,
    contentEntries,
  };
}

export function collectLeadingTopNavEntries(entries: SnapshotEntry[]): SnapshotEntry[] {
  const topNavEntries: SnapshotEntry[] = [];

  for (const entry of entries) {
    if (isTopNavEntry(entry)) {
      topNavEntries.push(entry);
      continue;
    }

    if (topNavEntries.length > 0) {
      break;
    }
  }

  return topNavEntries;
}
