import type { CdpClient } from "../cdp/client.js";
import { inferSurface } from "./scopeResolver.js";
import { FEED_POST_CAP, FEED_POST_SYNTH_JS } from "./snapshotCapture/feedPostSynth.js";
import {
  synthesizeMessagingComposerEntries,
  synthesizeMessagingTranscriptEntries,
} from "./snapshotCapture/messagingConversationSynth.js";
import { synthesizePostComposerEntries } from "./snapshotCapture/postComposerSynth.js";
import { hasComposerSignals } from "./inspectSummary.js";
import { PROFILE_SYNTH_JS } from "./snapshotCapture/profileSynth.js";
import { tagAsideClickables } from "./snapshotCapture/regionTag.js";
import { SEARCH_RESULT_SYNTH_JS } from "./snapshotCapture/searchResultSynth.js";
import type { CurrentSurfaceContext, RefMap, SnapshotEntry } from "./types.js";
export * from "./snapshotCapture/feedPostSynth.js";
export * from "./snapshotCapture/profileSynth.js";
export * from "./snapshotCapture/searchResultSynth.js";
type FeedPostRaw = { author: string; headline: string; profileUrl: string | null };
type ProfileCardRaw = { name: string; headline: string | null; company: string | null; location: string | null; connections: string | null };
type SearchResultRaw = { slug: string; name: string; profileUrl: string };
// Mark visible overlay items with a transient data-attr (DOM query is NOT subject to the AX-tree
// aria-hidden timing race — RC-1), return their {idx, role, label}. Skips aria-hidden subtrees +
// invisible nodes (avoids surfacing CLOSED-dropdown items still in the DOM).
//
// [Phase 10 2026-06-08] For role=dialog / role=alertdialog matches, ALSO enumerate clickable
// children (button, [role=button], a[role=button]) as separate entries. Without this, the
// 2nd-degree Connect-invite modal ("Add a note to your invitation?") surfaced as ONE dialog
// entry with no clickable inner buttons — agent's inspect saw the modal text but couldn't
// click(label="Send invitation"). Hootan Farhat 2026-05-25 + Dmitry Balanovsky 2026-06-08.
const OVERLAY_SYNTH_JS = `(() => {
  const vis = (el) => { const s = getComputedStyle(el); if (s.display==='none'||s.visibility==='hidden'||s.opacity==='0') return false; const r = el.getBoundingClientRect(); return r.width>0 && r.height>0; };
  const out = []; let i = 0;
  for (const el of document.querySelectorAll('[role="menuitem"],[role="option"],[role="dialog"],[role="alertdialog"],[data-test-modal]')) {
    if (!vis(el) || el.closest('[aria-hidden="true"]')) continue;
    i++; el.setAttribute('data-frondose-ov', String(i));
    const elRole = el.getAttribute('role')||'';
    const isDialog = elRole.includes('dialog') || el.hasAttribute('data-test-modal');
    const role = isDialog ? 'dialog' : 'menuitem';
    const label = (el.getAttribute('aria-label') || el.innerText || '').trim().slice(0,120);
    out.push({ i, role, label });
    // [Phase 10] Enumerate dialog's INNER clickable children so the agent can click them.
    // Without this, agents reach the modal but can't click(label='Send invitation') because
    // the AX-tree-flat capture surfaces ~39 page-level buttons that crowd the modal buttons
    // out of MAX_BUTTONS=12. Inner-button refs (@ov<N>) lead and survive truncation.
    if (isDialog) {
      const innerSel = 'button,[role="button"],a[role="button"]';
      for (const btn of el.querySelectorAll(innerSel)) {
        if (!vis(btn)) continue;
        i++; btn.setAttribute('data-frondose-ov', String(i));
        const btnLabel = (btn.getAttribute('aria-label') || btn.innerText || '').trim().slice(0,120);
        if (!btnLabel) { i--; btn.removeAttribute('data-frondose-ov'); continue; }
        out.push({ i, role: 'button', label: btnLabel });
      }
    }
  }
  return JSON.stringify(out);
})()`;
// Mark the PROFILE-level More button (NOT the nav More), return its name + label. Reuses the
// PROFILE_SYNTH_JS NAV_SELECTOR + title/h1 anchor. evaluate-mark → querySelectorAll → describeNode
// gives a real backendNodeId (clickable), like synthesizeOverlayEntries.
const PROFILE_MORE_SYNTH_JS = `(() => {
  const norm = (s) => (s||"").replace(/\\s+/g," ").trim();
  const NAV = "[role='banner'],[role='navigation'],nav,header";
  const m = document.title.match(/^(.+?)\\s*\\|\\s*LinkedIn\\b/);
  const name = m ? (m[1].includes(' - ') ? m[1].split(' - ')[0] : m[1]).trim() : null;
  const headings = Array.from(document.querySelectorAll("h1,h2,h3"));
  const h1 = name ? (headings.find(el => norm(el.innerText)===name && !el.closest(NAV)) || headings.find(el => norm(el.innerText)===name)) : null;
  const cands = Array.from(document.querySelectorAll('button[aria-label*="More" i],[role="button"][aria-label*="More" i]'))
    .filter(el => !el.closest(NAV));
  let pick = h1 ? cands.find(el => h1.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) : null;
  if (!pick) pick = cands[0] || null;
  if (!pick) return JSON.stringify(null);
  pick.setAttribute('data-frondose-pm','1');
  return JSON.stringify({ name, label: norm(pick.getAttribute('aria-label')||pick.innerText||'More') });
})()`;

// [P-75 D-11] The SUBJECT's primary action controls (Connect/Message/Follow/More), scoped to the
// top card. Root cause this fixes (references/surface-profile.md:37): the profile Connect renders as
// an <a> (role=link), and the flat AX tree mixes the subject's actions with a dozen sidebar
// "People you may know" / "More profiles for you" invite/follow BUTTONS — so the agent was shown
// "Invite Jason Adkins to connect" (a sidebar suggestion) ranked above the subject's own controls,
// and the subject's Connect (a link, often behind "More") never surfaced. This synth isolates the
// subject's action row via the h1 anchor (nav/aside excluded) and keeps only controls that reference
// the subject by name OR are a bare top-level action — dropping the sidebar "Invite <Other>" noise.
const PROFILE_ACTIONS_SYNTH_JS = `(() => {
  const norm = (s) => (s||"").replace(/\\s+/g," ").trim();
  const EXCL = "[role='banner'],[role='navigation'],nav,header,aside,[role='complementary']";
  const m = document.title.match(/^(.+?)\\s*\\|\\s*LinkedIn\\b/);
  const name = m ? (m[1].includes(' - ') ? m[1].split(' - ')[0] : m[1]).trim() : null;
  if (!name) return JSON.stringify(null);
  const headings = Array.from(document.querySelectorAll("h1,h2,h3"));
  const h1 = headings.find(el => norm(el.innerText)===name && !el.closest(EXCL)) || headings.find(el => norm(el.innerText)===name);
  if (!h1) return JSON.stringify(null);
  // Climb from the h1 to the container that actually holds the action row (Connect/Message/More),
  // staying within the top card and out of nav/aside.
  let card = h1.closest('section') || h1.parentElement;
  for (let k=0; k<3 && card && card.parentElement; k++) {
    if (card.querySelector('button[aria-label*="More" i],a[aria-label*="connect" i],button[aria-label*="Message" i],a[aria-label*="Message" i]')) break;
    card = card.parentElement;
  }
  if (!card) return JSON.stringify(null);
  const ACTION_RE = /\\b(connect|invite\\b.*\\bto connect|message|more|follow|pending|following)\\b/i;
  const BARE_RE = /^(connect|message|more|follow|pending|following)\\b/i;
  const nameLc = name.toLowerCase();
  const out = []; let i = 0;
  const cands = Array.from(card.querySelectorAll('button,a[role="button"],a[aria-label]')).filter(el => !el.closest(EXCL));
  for (const el of cands) {
    const label = norm(el.getAttribute('aria-label') || el.innerText);
    if (!label || label.length > 80 || !ACTION_RE.test(label)) continue;
    const refsSubject = label.toLowerCase().includes(nameLc);
    const bare = BARE_RE.test(label) && label.length < 40;
    if (!refsSubject && !bare) continue; // drop sidebar "Invite <Other> to connect" / "Follow <Other>"
    if (out.some(o => o.label === label)) continue;
    i++; el.setAttribute('data-frondose-pa', String(i));
    const role = (el.tagName === 'A' && el.getAttribute('role') !== 'button') ? 'link' : 'button';
    out.push({ i, role, label });
  }
  const hasMore = out.some(o => /^more\\b/i.test(o.label) || /more actions/i.test(o.label));
  const hasConnectish = out.some(o => /^(?:connect|pending|following)\\b/i.test(o.label) || /\\binvite\\b.*\\bto\\s+connect\\b/i.test(o.label));
  if (hasMore && !hasConnectish) {
    out.push({ i: -1, role: 'text', label: 'Connect is under "More" — click the profile "More" action (@pm1), then inspect scope:"overlay" and click "Connect".' });
  }
  return JSON.stringify({ name, actions: out });
})()`;

/** Capture the current surface: AX snapshot + URL routing + (messaging) opener synthesis. */
export async function captureCurrentSurfaceContext(client: CdpClient): Promise<CurrentSurfaceContext> {
  await client.snapshot();
  const refMap = client.currentRefMap;
  const asideIds = await tagAsideClickables(client);
  const entries: SnapshotEntry[] = Object.entries(refMap).map(([key, e]) => ({
    ref: `@${key}`,
    role: e.role,
    name: e.name ?? "",
    region: asideIds.has(e.backendNodeId) ? "aside" : undefined,
  }));

  const pageUrl = await client.getCurrentUrl();
  const surface = inferSurface(pageUrl);

  if (surface === "messaging-thread") {
    entries.unshift(...(await synthesizeMessagingTranscriptEntries(client)));
    const composer = await synthesizeMessagingComposerEntries(client);
    if (composer.entries.length > 0) {
      entries.push(...composer.entries);
      client.mergeRefs(composer.refs);
    }
  } else if (surface === "messaging") {
    const synth = await synthesizeMessagingConversationOpeners(client);
    entries.push(...synth);
  } else if (surface === "feed") {
    entries.push(...(await synthesizeFeedPostEntries(client))); // P-37 B4
    if (hasComposerSignals(entries)) { const post = await synthesizePostComposerEntries(client); if (post.entries.length > 0) { entries.push(...post.entries); client.mergeRefs(post.refs); } }
  } else if (surface === "search" || surface === "network") {
    // P-AUTO-3 (B3): synthesize person entries on the search + network discovery
    // surfaces. unshift so synthetic rows lead the list and survive MAX_TEXT truncation.
    entries.unshift(...(await synthesizeSearchResultEntries(client)));
  } else if (surface === "profile") {
    // P-47 G-3 (OQ-3): PREPEND the structured profile entries at index 0 so
    // they lead the text list ahead of the ~15 nav/sidebar entries and survive
    // the buildInspectSummary MAX_TEXT=40 truncation.
    entries.unshift(...(await synthesizeProfileEntries(client)));
    // [INSPECT-1 5a] disambiguate the PROFILE More (opens the Connect dropdown) from the nav More.
    const pm = await synthesizeProfileMoreEntry(client);
    if (pm.entries.length > 0) {
      entries.unshift(...pm.entries); // lead the list (survives MAX_TEXT truncation, like @pp)
      client.mergeRefs(pm.refs); // register so clickAt("@pm1") resolves (same lynchpin as overlay)
    }
    // [P-75 D-11] Surface the SUBJECT's scoped primary action controls (Connect-as-<a>/Message/Follow)
    // ahead of the sidebar "People you may know" invite/follow noise that polluted the flat AX buttons
    // and buried the subject's own Connect. Prepended LAST so these lead the entire list.
    const pa = await synthesizeProfileActionEntries(client);
    if (pa.entries.length > 0) {
      entries.unshift(...pa.entries);
      client.mergeRefs(pa.refs);
    }
  }

  // [INSPECT-1] Inject the open overlay/dropdown layer (AX-tree blind-spot) + register its refs so
  // the agent can click items like "Connect". activeLayer flips to "overlay" when items are present.
  const overlay = await synthesizeOverlayEntries(client);
  if (overlay.entries.length > 0) {
    entries.push(...overlay.entries);
    client.mergeRefs(overlay.refs);
  }
  return { pageUrl, surface, activeLayer: overlay.entries.length > 0 ? "overlay" : "page", entries };
}

/** [INSPECT-1] Synthesize CLICKABLE overlay entries (open dropdown/dialog layer the AX tree drops).
 *  Returns entries + refs; refs MUST be merged into the client refMap by the caller so clickAt resolves.
 *  Best-effort — any failure yields empty (never throws). */
async function synthesizeOverlayEntries(client: CdpClient): Promise<{ entries: SnapshotEntry[]; refs: RefMap }> {
  // D-G6 fix: artdeco-modal "Invite to connect" opens with an opacity:0→1 CSS
  // transition (~150-300ms). When inspect() fires immediately after a click with
  // pacing=0, the dialog is mid-transition and OVERLAY_SYNTH_JS's vis() filter
  // (opacity==='0' → false) drops it. Retry ONCE after a 350ms settle if the
  // first eval returned 0 entries. Bounded: never more than one retry.
  const evalOverlay = async (): Promise<Array<{ i: number; role: string; label: string }>> => {
    try {
      const raw = JSON.parse(await client.evaluate<string>(OVERLAY_SYNTH_JS)) as Array<{
        i: number;
        role: string;
        label: string;
      }>;
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  };
  let items = await evalOverlay();
  if (items.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 350));
    items = await evalOverlay();
  }
  if (items.length === 0) {
    return { entries: [], refs: {} };
  }
  const entries: SnapshotEntry[] = [];
  const refs: RefMap = {};
  for (const it of items) {
    if (!it.label) continue;
    try {
      const nodeIds = await client.querySelectorAll(`[data-frondose-ov="${it.i}"]`);
      const nodeId = nodeIds[0];
      if (typeof nodeId !== "number") continue;
      const desc = await client.raceHandle(client.handle.DOM.describeNode({ nodeId }), "snapshot.describeNode");
      const backendNodeId = desc.node?.backendNodeId;
      if (typeof backendNodeId !== "number") continue;
      const ref = `ov${it.i}`;
      refs[ref] = { axNodeId: "", backendNodeId, role: it.role, name: it.label };
      entries.push({ ref: `@${ref}`, role: it.role, name: it.label });
    } catch {
      // skip this item
    }
  }
  // best-effort cleanup of the transient markers (zero net DOM mutation)
  try {
    await client.evaluate("document.querySelectorAll('[data-frondose-ov]').forEach(e=>e.removeAttribute('data-frondose-ov'));");
  } catch {
    // best-effort cleanup
  }
  return { entries, refs };
}

/** [INSPECT-1 5a] Synthesize a DISTINCT, clickable entry for the PROFILE-level More button so the
 *  agent doesn't mis-target the nav-bar More. Best-effort — never throws. */
async function synthesizeProfileMoreEntry(client: CdpClient): Promise<{ entries: SnapshotEntry[]; refs: RefMap }> {
  let info: { name: string | null; label: string } | null = null;
  try {
    info = JSON.parse(await client.evaluate<string>(PROFILE_MORE_SYNTH_JS));
  } catch {
    return { entries: [], refs: {} };
  }
  if (!info) return { entries: [], refs: {} };
  try {
    const nodeIds = await client.querySelectorAll('[data-frondose-pm="1"]');
    const nodeId = nodeIds[0];
    try {
      await client.evaluate("document.querySelectorAll('[data-frondose-pm]').forEach(e=>e.removeAttribute('data-frondose-pm'));");
    } catch {
      // best-effort cleanup
    }
    if (typeof nodeId !== "number") return { entries: [], refs: {} };
    const desc = await client.raceHandle(client.handle.DOM.describeNode({ nodeId }), "snapshot.describeNode");
    const backendNodeId = desc.node?.backendNodeId;
    if (typeof backendNodeId !== "number") return { entries: [], refs: {} };
    const ref = "pm1";
    const label = info.name ? `More actions for ${info.name}` : "More actions (profile)";
    return {
      entries: [{ ref: `@${ref}`, role: "button", name: label }],
      refs: { [ref]: { axNodeId: "", backendNodeId, role: "button", name: label } },
    };
  } catch {
    return { entries: [], refs: {} };
  }
}

/** P-37 B4: synthesize feed-post entries from the rendered feed DOM. */
async function synthesizeFeedPostEntries(client: CdpClient): Promise<SnapshotEntry[]> {
  let posts: FeedPostRaw[] = [];
  try {
    posts = JSON.parse(await client.evaluate<string>(FEED_POST_SYNTH_JS)) as FeedPostRaw[];
  } catch {
    return []; // best-effort — a feed with no extractable posts yields no entries
  }
  return posts.slice(0, FEED_POST_CAP).map((p, i) => ({
    ref: `@fp${i + 1}`,
    role: "feedPost",
    name: p.profileUrl ? `Post by ${p.author} (${p.profileUrl}): ${p.headline}` : `Post by ${p.author}: ${p.headline}`,
  }));
}

/** P-AUTO-3 (B3): synthesize person entries on the search + network discovery surfaces. */
async function synthesizeSearchResultEntries(client: CdpClient): Promise<SnapshotEntry[]> {
  let rows: SearchResultRaw[] = [];
  try {
    rows = JSON.parse(await client.evaluate<string>(SEARCH_RESULT_SYNTH_JS)) as SearchResultRaw[];
  } catch {
    return [];
  }
  // name embeds the /in/ URL → agent records WITHOUT navigating, and role::name dedupe is URL-unique.
  return rows.map((r, i) => ({ ref: `@sr${i}`, role: "searchResult", name: `${r.name} — ${r.profileUrl}` }));
}

/** P-47 G-3: synthesize structured profile-card entries from the profile DOM.
 *  Best-effort — any extraction failure yields no entries (never throws). */
/** [P-75 D-11] Resolve the subject's scoped primary action controls (Connect-as-link / Message /
 *  Follow / More) to clickable refs. Mirrors synthesizeProfileMoreEntry: evaluate-mark → resolve each
 *  marked node to a real backendNodeId via describeNode → register @pa{i} refs. Best-effort; never throws. */
async function synthesizeProfileActionEntries(client: CdpClient): Promise<{ entries: SnapshotEntry[]; refs: RefMap }> {
  let info: { name: string | null; actions: Array<{ i: number; role: string; label: string }> } | null = null;
  try {
    info = JSON.parse(await client.evaluate<string>(PROFILE_ACTIONS_SYNTH_JS));
  } catch {
    return { entries: [], refs: {} };
  }
  if (!info || !Array.isArray(info.actions) || info.actions.length === 0) return { entries: [], refs: {} };
  const entries: SnapshotEntry[] = [];
  const refs: RefMap = {};
  for (const a of info.actions) {
    if (a.i === -1) {
      entries.push({ ref: "", role: "text", name: a.label });
      continue;
    }
    try {
      const nodeIds = await client.querySelectorAll(`[data-frondose-pa="${a.i}"]`);
      const nodeId = nodeIds[0];
      if (typeof nodeId !== "number") continue;
      const desc = await client.raceHandle(client.handle.DOM.describeNode({ nodeId }), "snapshot.describeNode");
      const backendNodeId = desc.node?.backendNodeId;
      if (typeof backendNodeId !== "number") continue;
      const ref = `pa${a.i}`;
      const role = a.role === "link" ? "link" : "button";
      entries.push({ ref: `@${ref}`, role, name: a.label });
      refs[ref] = { axNodeId: "", backendNodeId, role, name: a.label };
    } catch {
      // best-effort per action
    }
  }
  try {
    await client.evaluate("document.querySelectorAll('[data-frondose-pa]').forEach(e=>e.removeAttribute('data-frondose-pa'));");
  } catch {
    // best-effort cleanup
  }
  return { entries, refs };
}

async function synthesizeProfileEntries(client: CdpClient): Promise<SnapshotEntry[]> {
  let p: ProfileCardRaw | null = null;
  try {
    p = JSON.parse(await client.evaluate<string>(PROFILE_SYNTH_JS)) as ProfileCardRaw | null;
  } catch {
    return []; // extraction / parse failure → no entries
  }
  if (!p || !p.name) return [];
  const out: SnapshotEntry[] = [];
  // @pp1 — identity line: name + headline.
  out.push({
    ref: "@pp1",
    role: "profileCard",
    name: (p.headline ? `${p.name} — ${p.headline}` : p.name).slice(0, 220),
  });
  // @pp2 — details line: present-only company / location / connections.
  const details = [p.company, p.location, p.connections].filter(
    (x): x is string => typeof x === "string" && x.length > 0,
  );
  if (details.length > 0) {
    out.push({ ref: "@pp2", role: "profileCard", name: `Profile: ${details.join(" · ")}` });
  }
  return out;
}

/** Synthesize `mr1, mr2, ...` refs for messaging conversation list items. */
async function synthesizeMessagingConversationOpeners(client: CdpClient): Promise<SnapshotEntry[]> {
  // Selector per mai-linkedin reference; OQ-P3.2 risk — verify in P-3 live smoke.
  const nodeIds = await client.querySelectorAll("li[class*='msg-conversation-listitem']");
  const out: SnapshotEntry[] = [];
  let i = 0;
  for (const nodeId of nodeIds) {
    i++;
    const ref = `@mr${i}`;
    let label = "";
    try {
      const attrs = await client.raceHandle(client.handle.DOM.getAttributes({ nodeId }), "snapshot.getAttributes");
      const arr = (attrs?.attributes ?? []) as string[];
      // Interleaved [name0, value0, name1, value1, ...] per CDP spec.
      for (let k = 0; k < arr.length - 1; k += 2) {
        if (arr[k] === "aria-label") {
          label = arr[k + 1] ?? "";
          break;
        }
      }
    } catch {
      // best-effort; continue with empty label
    }
    out.push({ ref, role: "messagingConversationOpener", name: label });
  }
  return out;
}
