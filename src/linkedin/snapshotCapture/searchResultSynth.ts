/** P-AUTO-3 (B3): synthesize person entries on the search + network discovery surfaces.
 *  The AX tree carries no /in/ URL, so a search-result person is unrecordable without a
 *  navigate→inspect→back round-trip. Every person on BOTH surfaces is an <a href*="/in/">;
 *  this enumerates them, canonicalizes to /in/<slug>/ (query/hash stripped — the
 *  record_raw_candidate contract), dedupes by slug, filters nav chrome, caps at 10. */
export const SEARCH_RESULT_SYNTH_JS = `(() => {
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const visible = (el) => {
    if (!(el instanceof Element)) return false;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const GENERIC = /^(message|connect|follow|following|view profile|view|pending|remove|ignore|accept|mutual connections?|\\d+ mutual|see all|show all)/i;
  // BLOCKER-1 fix: scope to <main> so the global-nav "Me" link (operator's own /in/) and other
  // header/nav chrome are excluded — structural, not BEM-class-dependent. Search results AND
  // /mynetwork/ connection cards both live inside <main>.
  const root = document.querySelector("main") || document.body;
  const out = [];
  const seen = new Set();
  for (const a of Array.from(root.querySelectorAll('a[href*="/in/"]'))) {
    if (!visible(a)) continue;
    const m = (a.getAttribute("href") || "").match(/\\/in\\/([^/?#]+)/);
    if (!m) continue;
    const slug = m[1].toLowerCase();
    if (seen.has(slug)) continue;
    // BLOCKER-2 fix: the /in/ anchor often wraps ONLY the avatar <img> (empty innerText) while the
    // name sits in a sibling span. Fall back to the nearest result row's name node so the person
    // is not silently lost. Substring class-match (not exact BEM) for resilience.
    let name = norm(a.innerText);
    if (!name) {
      const row = a.closest("li") || a.closest('[class*="entity-result"]') || a.closest('[class*="connection-card"]');
      if (row) {
        const cand =
          row.querySelector('span[dir="ltr"] span[aria-hidden="true"]') ||
          row.querySelector('span[aria-hidden="true"]') ||
          row.querySelector('[class*="title"] a, [class*="name"]');
        name = norm(cand ? cand.innerText : "");
      }
    }
    if (name.length < 2 || GENERIC.test(name)) continue;
    seen.add(slug);
    out.push({ slug, name: name.slice(0, 80), profileUrl: "https://www.linkedin.com/in/" + slug + "/" });
    if (out.length >= 10) break;
  }
  return JSON.stringify(out);
})()`;
