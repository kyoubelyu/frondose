/** P-47 G-3: synthesize a structured profile card from the rendered profile DOM.
 *  The AX tree buries name/headline/location under ~15 nav/sidebar entries; this
 *  h1-anchored DOM scan (ported from mai-linkedin profileFieldExtractor.ts)
 *  extracts the identity fields directly. ASSUMED-confidence (plan OQ-2) — the
 *  Step-5 live test against a real LinkedIn profile is the authoritative check. */
export const PROFILE_SYNTH_JS = `(() => {
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const CHROME_PREFIXES = [
    "Profile photo", "Edit profile", "Edit background", "Contact info",
    "Add section", "Open to", "Compose", "Message", "Connect",
    "Manage notifications", "View", "Follow", "Report", "Pending", "Save",
  ];
  const isChrome = (t) => CHROME_PREFIXES.some((p) => t.startsWith(p));
  const titleMatch = document.title.match(/^(.+?)\\s*\\|\\s*LinkedIn\\b/);
  if (!titleMatch) return JSON.stringify(null);
  let name = titleMatch[1].trim();
  if (name.includes(' - ')) name = name.split(' - ')[0].trim();
  const headings = Array.from(document.querySelectorAll("h1, h2, h3"));
  const NAV_SELECTOR = "[role='banner'], [role='navigation'], nav, header";
  let anchor = headings.find(el => norm(el.innerText) === name && !el.closest(NAV_SELECTOR));
  if (!anchor) anchor = headings.find(el => norm(el.innerText) === name);
  if (!anchor) return JSON.stringify(null);
  const afterH1Ps = Array.from(document.querySelectorAll("p, span[class*='_']"))
    .filter((el) => anchor.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
    .slice(0, 20);
  let headline = null;
  let subtitle = null;
  let location = null;
  for (const p of afterH1Ps) {
    const t = norm(p.innerText);
    if (!t || t.length < 3) continue;
    if (isChrome(t)) continue;
    if (t.toLowerCase() === name.toLowerCase()) continue;
    if (t.startsWith("·")) continue;
    if (!headline && !t.includes("·") && t.length >= 8) {
      headline = t.slice(0, 200);
    } else if (!subtitle && t.includes("·") && !t.startsWith("·")) {
      subtitle = t.slice(0, 200);
    } else if (subtitle && !location) {
      if (!t.includes("·") && !/^\\d/.test(t) && t.length >= 3 && t.length <= 80) {
        location = t;
      }
    }
    if (headline && subtitle && location) break;
  }
  const company = subtitle ? ((subtitle.split("·")[0] || "").trim() || null) : null;
  const connEl = Array.from(document.querySelectorAll("a, span")).find((el) => {
    const t = norm(el.innerText);
    return /\\d.*connection/i.test(t) && t.length < 50;
  });
  const connections = connEl ? norm(connEl.innerText) : null;
  return JSON.stringify({ name, headline, company, location, connections });
})()`;
