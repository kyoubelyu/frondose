/** P-37 B4: synthesize feed-post entries — LinkedIn's feed DOM does not expose
 *  post author/body in the AX tree. Heuristic is TEXT-SIGNAL-PRIMARY (OQ-2):
 *  the post container is the nearest ancestor whose innerText carries a
 *  post-action signal — NOT the `feed-shared-update-v2` BEM class (which churns).
 *  Capped at 5 posts (the feed renders ~5-7 visible per scroll). */
export const FEED_POST_SYNTH_JS = `(() => {
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const visible = (el) => {
    if (!(el instanceof Element)) return false;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const SIGNALS = ["comment", "repost", "reaction"];
  const anchors = Array.from(document.querySelectorAll("button,[role='button']"))
    .filter((b) => /^Open control menu for post by /i.test(norm(b.getAttribute("aria-label") || b.innerText)) && visible(b))
    .slice(0, 5);
  const out = [];
  for (const a of anchors) {
    const author = norm(a.getAttribute("aria-label") || a.innerText)
      .replace(/^Open control menu for post by /i, "").trim();
    // text-signal-primary container walk (D-3): ascend until innerText carries
    // a post-action signal. No reliance on the feed-shared-update-v2 class.
    let container = a, hops = 0;
    while (container.parentElement && hops < 12) {
      container = container.parentElement; hops++;
      if (SIGNALS.some((sig) => (container.innerText || "").toLowerCase().includes(sig))) break;
    }
    const actor = container.querySelector('[class*="actor"]') || container;
    const link = actor.querySelector('a[href*="/in/"], a[href*="/company/"]');
    const profileUrl = link ? link.getAttribute("href") : null;
    let headline = "";
    for (const el of container.querySelectorAll("span,div,p")) {
      if (!visible(el)) continue;
      const t = norm(el.innerText);
      if (t.length > 12 && !t.startsWith(author) && !/^Open control menu/i.test(t)) { headline = t; break; }
    }
    out.push({ author, headline: headline.slice(0, 160), profileUrl });
  }
  return JSON.stringify(out);
})()`;
