import type { CdpClient } from "../../../cdp/client.js";
import { inspectSummarySchema, type VisibleScopeInspection } from "../contracts/inspect.js";
import { collectActiveCommentComposerEntries } from "./commentComposer.js";
import { buildVisibleScopeInspections as assembleVisibleScopeInspections } from "./buildVisibleScopeInspections.js";
import { buildCurrentSurfaceSummaryAssembly } from "./currentSurfaceSummary.js";
import type { CurrentSurfaceContext, SnapshotEntry, SnapshotRef } from "./currentSurfaceTypes.js";
import {
  activeLayerForForegroundContext,
  createForegroundContextFromSurface,
  detectFeedSignals,
  detectMessagingSignals,
  inferSurfaceId,
  inspectEntriesForPage,
} from "./foregroundContext.js";

export {
  inferActiveLayer,
  inferSurfaceId,
  isCommentButtonEntry,
  isCommentInputEntry,
  isMessagingConversationEntry,
  isMessagingListEntry,
  isMessagingSearchEntry,
  isPostActionEntry,
  isThreadComposerButtonEntry,
  isThreadComposerInputEntry,
} from "./foregroundContext.js";
export { buildScopeInspection, buildVisibleScopeInspection, scopeOwnsEntry } from "./scopeProjection.js";
export type {
  CurrentSurfaceContext,
  RuntimeVisibleScopeControl,
  RuntimeVisibleScopeInspection,
  SnapshotEntry,
} from "./currentSurfaceTypes.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function numericRef(ref: string): number {
  const match = ref.match(/\d+/);
  return match ? Number(match[0]) : Number.MAX_SAFE_INTEGER;
}

function normalizeSnapshotRef(ref: string): string {
  return /^e\d+$/i.test(ref) ? `@${ref}` : ref;
}

// Batch D-followup: messaging preload-frame TODO. Frondose's current CdpClient.evaluate()
// runs in the main frame; the mai-linkedin fallback targeted LinkedIn's /preload/ iframe.
// Until CdpClient grows a typed cross-frame eval primitive, this path intentionally
// reports no fallback refs rather than silently pretending the iframe was inspected.
export async function snapshotInteractiveFromMessagingPreloadFrame(
  _client: CdpClient,
): Promise<Record<string, SnapshotRef> | null> {
  return null;
}

async function snapshotInteractive(client: CdpClient, pageUrl: string): Promise<Record<string, SnapshotRef>> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const snapshot = await client.snapshot();
      if (snapshot.refs && Object.keys(snapshot.refs).length > 0) {
        return snapshot.refs;
      }
      lastError = new Error(
        "LinkedIn snapshot did not expose interactive refs yet. Wait for the current surface to settle and retry.",
      );
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    if (attempt < 2) {
      await sleep(400);
    }
  }

  if (pageUrl.toLowerCase().includes("/messaging/")) {
    const preloadRefs = await snapshotInteractiveFromMessagingPreloadFrame(client);
    if (preloadRefs && Object.keys(preloadRefs).length > 0) {
      return preloadRefs;
    }
  }

  throw (
    lastError ??
    new Error(
      "LinkedIn snapshot did not expose interactive refs yet. Wait for the current surface to settle and retry.",
    )
  );
}

function normalizeEntries(refs: Record<string, SnapshotRef>): SnapshotEntry[] {
  return Object.entries(refs)
    .filter(([, value]) => Boolean(value) && typeof value === "object")
    .map(([ref, value]) => ({
      ref: normalizeSnapshotRef(ref),
      role: value.role ?? "unknown",
      name: (value.name ?? "").trim(),
      ...(value.selector ? { selector: value.selector } : {}),
    }))
    .sort((left, right) => numericRef(left.ref) - numericRef(right.ref));
}

async function snapshotMessagingConversationOpeners(client: CdpClient): Promise<SnapshotEntry[]> {
  let stdout: string;
  try {
    stdout = await client.evaluate<string>(`(() => {
      const normalize = (value) => (value || "").replace(/\\s+/g, " ").trim();
      const frame = Array.from(document.querySelectorAll("iframe")).find((candidate) => candidate.getAttribute("src") === "/preload/");
      const frameDoc =
        frame instanceof HTMLIFrameElement && frame.contentDocument && frame.contentWindow
          ? { doc: frame.contentDocument, view: frame.contentWindow }
          : null;
      const mainRows = Array.from(document.querySelectorAll("li.msg-conversation-listitem"));
      const rows =
        mainRows.length > 0 ? mainRows : Array.from(frameDoc?.doc.querySelectorAll("li.msg-conversation-listitem") ?? []);
      const view = rows.length > 0 && frameDoc && rows[0]?.ownerDocument === frameDoc.doc ? frameDoc.view : window;
      const isVisible = (el) => {
        if (!(el instanceof view.HTMLElement)) {
          return false;
        }
        const style = view.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || "1") === 0) {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < view.innerHeight;
      };
      const entries = [];
      let index = 0;
      for (const row of rows) {
        if (!(row instanceof view.HTMLElement) || !isVisible(row)) {
          continue;
        }

        const opener = row.querySelector(".msg-conversation-listitem__link[tabindex]");
        if (!(opener instanceof view.HTMLElement) || !isVisible(opener)) {
          continue;
        }

        const name =
          normalize(row.querySelector(".msg-conversation-card__participant-names .truncate")?.textContent) ||
          normalize(row.querySelector(".msg-conversation-listitem__participant-names .truncate")?.textContent);
        if (!name) {
          continue;
        }

        index += 1;
        const selector = row.id
          ? \`li#\${CSS.escape(row.id)} .msg-conversation-listitem__link\`
          : \`li.msg-conversation-listitem:nth-of-type(\${index}) .msg-conversation-listitem__link\`;
        entries.push({
          ref: \`mr\${index}\`,
          role: "button",
          name: \`Open conversation with \${name}\`,
          selector,
        });
      }

      return JSON.stringify({ entries });
    })()`);
  } catch {
    return [];
  }

  if (!stdout) {
    return [];
  }

  try {
    const parsed = JSON.parse(stdout) as { entries?: SnapshotEntry[] } | string;
    const payload = typeof parsed === "string" ? (JSON.parse(parsed) as { entries?: SnapshotEntry[] }) : parsed;
    return (payload.entries ?? []).filter((entry) => entry.selector && entry.name && entry.role);
  } catch {
    return [];
  }
}

interface InputValueTuple {
  role: string;
  label: string;
  value: string;
}

async function enrichSnapshotEntriesWithInputValues(
  client: CdpClient,
  entries: SnapshotEntry[],
): Promise<SnapshotEntry[]> {
  let stdout: string;
  try {
    stdout = await client.evaluate<string>(`(() => {
      const normalize = (value) => (value || "").replace(/\\s+/g, " ").trim();
      const SELECTOR = "[role='textbox'],[role='searchbox'],[role='combobox'],[role='textarea'],textarea,input";
      const tuples = [];
      const collectFromRoot = (root, depth) => {
        for (const el of root.querySelectorAll(SELECTOR)) {
          const tag = el.tagName.toLowerCase();
          const type = (el.getAttribute("type") || "").toLowerCase();
          let role = el.getAttribute("role");
          if (!role) {
            if (tag === "textarea") role = "textbox";
            else if (tag === "input") role = type === "search" ? "searchbox" : "textbox";
          }
          if (!role) continue;
          const label = normalize(el.getAttribute("aria-label") || el.getAttribute("placeholder") || "");
          const value = normalize(el.value || el.innerText || el.textContent || "");
          tuples.push({ role, label, value });
        }
        if (depth >= 2) return;
        for (const host of root.querySelectorAll("*")) {
          if (host.shadowRoot) collectFromRoot(host.shadowRoot, depth + 1);
        }
      };
      collectFromRoot(document, 0);
      return JSON.stringify(tuples);
    })()`);
  } catch {
    return entries;
  }

  if (!stdout) {
    return entries;
  }

  let tuples: InputValueTuple[] = [];
  try {
    const parsed = JSON.parse(stdout) as InputValueTuple[] | string;
    tuples = Array.isArray(parsed) ? parsed : (JSON.parse(parsed) as InputValueTuple[]);
  } catch {
    return entries;
  }

  const matchedValues = new Map<number, string>();
  const tupleUsage = new Set<number>();

  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex];
    if (!entry || !entry.name) continue;

    const candidates: number[] = [];
    for (let tupleIndex = 0; tupleIndex < tuples.length; tupleIndex += 1) {
      if (tupleUsage.has(tupleIndex)) continue;
      const tuple = tuples[tupleIndex];
      if (tuple && tuple.role === entry.role && tuple.label === entry.name) {
        candidates.push(tupleIndex);
      }
    }

    if (candidates.length === 1) {
      const tupleIndex = candidates[0];
      if (tupleIndex === undefined) continue;
      const tuple = tuples[tupleIndex];
      if (!tuple) continue;
      tupleUsage.add(tupleIndex);
      matchedValues.set(entryIndex, tuple.value);
    } else if (candidates.length > 1) {
      const withValue = candidates.filter((i) => tuples[i]?.value);
      if (withValue.length === 1) {
        const tupleIndex = withValue[0];
        if (tupleIndex === undefined) continue;
        const tuple = tuples[tupleIndex];
        if (!tuple) continue;
        tupleUsage.add(tupleIndex);
        matchedValues.set(entryIndex, tuple.value);
      }
    }
  }

  if (matchedValues.size === 0) {
    return entries;
  }

  return entries.map((entry, index) =>
    matchedValues.has(index) ? { ...entry, value: matchedValues.get(index) } : entry,
  );
}

interface PScrapeTuple {
  selector: string;
  name: string;
  role: string;
}

async function scrapePLabelInputEntries(client: CdpClient): Promise<SnapshotEntry[]> {
  let stdout: string;
  try {
    stdout = await client.evaluate<string>(`(() => {
      const normalize = (value) => (value || "").replace(/\\s+/g, " ").trim();
      const cssEscape = (typeof window !== "undefined" && window.CSS && window.CSS.escape)
        ? window.CSS.escape
        : (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => "\\\\" + ch);
      const inputs = Array.from(document.querySelectorAll(
        "input,textarea,[role='textbox'],[role='combobox'],[role='searchbox']"
      ));
      const out = [];
      let stampCounter = 0;
      for (const el of inputs) {
        const ariaLabel = el.getAttribute && el.getAttribute("aria-label");
        const ariaLabelledBy = el.getAttribute && el.getAttribute("aria-labelledby");
        const id = el.getAttribute && el.getAttribute("id");
        let labelEl = null;
        if (id) {
          try { labelEl = document.querySelector("label[for='" + cssEscape(id) + "']"); } catch (e) {}
        }
        if (ariaLabel || ariaLabelledBy || labelEl) continue;

        let scope = el.parentElement;
        let depth = 0;
        let pText = null;
        while (scope && depth < 5 && !pText) {
          const ps = scope.querySelectorAll(":scope p, :scope > div p");
          for (let i = 0; i < ps.length; i += 1) {
            const p = ps[i];
            const pos = p.compareDocumentPosition(el);
            if (pos & Node.DOCUMENT_POSITION_FOLLOWING) {
              const t = normalize(p.innerText || p.textContent || "");
              if (t && t.length <= 200) { pText = t; break; }
            }
          }
          scope = scope.parentElement;
          depth += 1;
        }
        if (!pText) continue;

        let selector;
        if (id && id.length > 0) {
          selector = '[id="' + id.replace(/\\\\/g, "\\\\\\\\").replace(/"/g, "\\\\\\"") + '"]';
        } else {
          stampCounter += 1;
          const stamp = "p" + Date.now() + "-" + stampCounter;
          el.setAttribute("data-mai-pscrape-target", stamp);
          selector = '[data-mai-pscrape-target="' + stamp + '"]';
        }

        let role = el.getAttribute && el.getAttribute("role");
        if (!role) {
          const tag = el.tagName.toLowerCase();
          if (tag === "textarea") role = "textbox";
          else if (tag === "input") {
            const type = (el.getAttribute("type") || "").toLowerCase();
            role = type === "search" ? "searchbox" : "textbox";
          } else {
            role = "textbox";
          }
        }

        out.push({ selector, name: pText, role });
      }
      return JSON.stringify(out);
    })()`);
  } catch {
    return [];
  }

  if (!stdout) {
    return [];
  }

  let tuples: PScrapeTuple[] = [];
  try {
    const parsed = JSON.parse(stdout) as PScrapeTuple[] | string;
    tuples = Array.isArray(parsed) ? parsed : (JSON.parse(parsed) as PScrapeTuple[]);
  } catch {
    return [];
  }

  return tuples
    .filter(
      (tuple) =>
        tuple &&
        typeof tuple.selector === "string" &&
        tuple.selector.length > 0 &&
        typeof tuple.name === "string" &&
        tuple.name.length > 0,
    )
    .map((tuple, index) => ({
      ref: `pscrape-${index + 1}`,
      role: tuple.role || "textbox",
      name: tuple.name,
      selector: tuple.selector,
    }));
}

export async function captureSnapshotEntries(
  client: CdpClient,
  includeInputValues = false,
): Promise<{ pageUrl: string; entries: SnapshotEntry[] }> {
  const pageUrl = await client.getCurrentUrl();
  const refs = await snapshotInteractive(client, pageUrl);
  let entries = normalizeEntries(refs);

  if (pageUrl.toLowerCase().includes("/messaging/")) {
    const syntheticConversationOpeners = await snapshotMessagingConversationOpeners(client);
    if (syntheticConversationOpeners.length > 0) {
      entries = [...entries, ...syntheticConversationOpeners];
    }
  }

  const pScrapeEntries = await scrapePLabelInputEntries(client);
  if (pScrapeEntries.length > 0) {
    entries = [...entries, ...pScrapeEntries];
  }

  if (includeInputValues && entries.length > 0) {
    entries = await enrichSnapshotEntriesWithInputValues(client, entries);
  }

  return { pageUrl, entries };
}

export async function buildVisibleScopeInspections(
  client: CdpClient,
  surface: string,
  entries: SnapshotEntry[],
  pageUrl: string,
  sourceEntries: SnapshotEntry[] = entries,
): Promise<VisibleScopeInspection[]> {
  return assembleVisibleScopeInspections(client, surface, entries, pageUrl, sourceEntries);
}

export async function captureCurrentSurfaceContext(
  client: CdpClient,
  options: { includeInputValues?: boolean } = {},
): Promise<CurrentSurfaceContext> {
  const { pageUrl, entries } = await captureSnapshotEntries(client, options.includeInputValues ?? false);
  const surface = inferSurfaceId(pageUrl, entries);
  const inspectEntries = inspectEntriesForPage(pageUrl, entries);
  const foregroundContext = createForegroundContextFromSurface(surface, pageUrl, entries);
  const activeLayer = activeLayerForForegroundContext(foregroundContext);
  const messagingSignals =
    foregroundContext.kind === "thread" || foregroundContext.kind === "local-overlay"
      ? detectMessagingSignals(entries, pageUrl)
      : undefined;
  const activeCommentComposerEntries =
    foregroundContext.kind === "page" && foregroundContext.routeBucket === "feed"
      ? collectActiveCommentComposerEntries(inspectEntries, pageUrl)
      : [];
  const feedSignals =
    foregroundContext.kind === "page" && foregroundContext.routeBucket === "feed"
      ? detectFeedSignals(
          activeCommentComposerEntries.some((entry) => /^(textbox|searchbox|combobox|textarea)$/i.test(entry.role)),
          inspectEntries,
          pageUrl,
        )
      : undefined;
  const summaryAssembly = buildCurrentSurfaceSummaryAssembly(
    foregroundContext,
    inspectEntries,
    entries,
    pageUrl,
    messagingSignals,
    feedSignals,
  );
  const visibleScopeInspections = await buildVisibleScopeInspections(client, surface, inspectEntries, pageUrl, entries);

  const summary = inspectSummarySchema.parse({
    surface,
    activeLayer,
    availableScopes: summaryAssembly.availableScopes,
    text: summaryAssembly.text,
    buttons: summaryAssembly.buttons,
    inputs: summaryAssembly.inputs,
    inputValues: summaryAssembly.inputValues,
    interactiveRegions: summaryAssembly.interactiveRegions,
    ambiguityCases: summaryAssembly.ambiguityCases,
    ...(visibleScopeInspections.length > 0
      ? { visibleScopes: visibleScopeInspections.map((inspection) => inspection.scope) }
      : {}),
  });

  return {
    pageUrl,
    surface,
    activeLayer,
    entries,
    repeatedControls: summaryAssembly.repeatedControls,
    summary,
    visibleScopeInspections,
  };
}
