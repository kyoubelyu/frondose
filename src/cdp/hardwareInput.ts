/** P-32: hardware-path input — posts real CGEvents via the in-house cgevent
 *  addon. Pure helpers (mouseCurve/jitter/mapKey/mapModifiers) are exported for
 *  unit tests; the CdpClient + CgEvent are injectable for mock tests. */
import { type CgEvent, loadCgEvent } from "../native/cgevent.js";
import type { CdpClient } from "./client.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** ±max-px integer offset — humanising micro-jitter on the click target. */
export function jitter(v: number, max = 4): number {
  return v + Math.round((Math.random() - 0.5) * max * 2);
}

/** Pure: a bounded, target-converging step list from `from` to `to`
 *  (replaces robotjs moveMouseSmooth; D-7 — unit-testable). */
export function mouseCurve(
  from: { x: number; y: number },
  to: { x: number; y: number },
): Array<{ x: number; y: number }> {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  if (dist < 1) return [to];
  const steps = Math.max(1, Math.min(40, Math.round(dist / 30)));
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // ease-in-out + small per-step wobble; last step lands exactly on `to`.
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    pts.push(
      i === steps
        ? { x: to.x, y: to.y }
        : {
            x: Math.round(from.x + (to.x - from.x) * e + (Math.random() - 0.5) * 3),
            y: Math.round(from.y + (to.y - from.y) * e + (Math.random() - 0.5) * 3),
          },
    );
  }
  return pts;
}

/** CDP key name → macOS virtual keycode. NIT-1: letters/digits included so
 *  `mapKey` is complete (the Cmd+A select-all in hardwareTypeAt uses `mapKey("A")`). */
const KEYCODES: Record<string, number> = {
  // Named keys.
  Enter: 36,
  Return: 36,
  Tab: 48,
  Space: 49,
  " ": 49,
  Backspace: 51,
  Delete: 117,
  Escape: 53,
  ArrowUp: 126,
  ArrowDown: 125,
  ArrowLeft: 123,
  ArrowRight: 124,
  // Letters (macOS US-QWERTY virtual keycodes — non-sequential).
  A: 0,
  B: 11,
  C: 8,
  D: 2,
  E: 14,
  F: 3,
  G: 5,
  H: 4,
  I: 34,
  J: 38,
  K: 40,
  L: 37,
  M: 46,
  N: 45,
  O: 31,
  P: 35,
  Q: 12,
  R: 15,
  S: 1,
  T: 17,
  U: 32,
  V: 9,
  W: 13,
  X: 7,
  Y: 16,
  Z: 6,
  // Digits.
  "0": 29,
  "1": 18,
  "2": 19,
  "3": 20,
  "4": 21,
  "5": 23,
  "6": 22,
  "7": 26,
  "8": 28,
  "9": 25,
};

export function mapKey(cdpKey: string): number {
  const code = KEYCODES[cdpKey] ?? KEYCODES[cdpKey.toUpperCase()];
  if (code === undefined) throw new Error(`hardware press: unmapped key '${cdpKey}'`);
  return code;
}

/** CDP modifiers bitmask (1=Alt,2=Ctrl,4=Meta,8=Shift) → CGEventFlags bitmask. */
export function mapModifiers(cdpMask: number): number {
  let f = 0;
  if (cdpMask & 1) f |= 0x0008_0000; // kCGEventFlagMaskAlternate
  if (cdpMask & 2) f |= 0x0004_0000; // kCGEventFlagMaskControl
  if (cdpMask & 4) f |= 0x0010_0000; // kCGEventFlagMaskCommand
  if (cdpMask & 8) f |= 0x0002_0000; // kCGEventFlagMaskShift
  return f;
}

/** Method A (OQ-4): DOM ref → absolute macOS logical-point screen coords. */
export async function resolveScreenCoords(client: CdpClient, ref: string): Promise<{ x: number; y: number }> {
  const win = JSON.parse(
    await client.evaluate<string>(
      "JSON.stringify({sx:window.screenX,sy:window.screenY,ch:window.outerHeight-window.innerHeight})",
    ),
  ) as { sx: number; sy: number; ch: number };
  const entry = client.currentRefMap[ref.replace(/^@/, "")];
  if (!entry) throw new Error(`hardware input: ref ${ref} not in current snapshot`);
  const box = await client.handle.DOM.getBoxModel({ backendNodeId: entry.backendNodeId });
  const b = box.model.border as number[];
  const cx = ((b[0] ?? 0) + (b[4] ?? 0)) / 2;
  const cy = ((b[1] ?? 0) + (b[5] ?? 0)) / 2;
  return { x: win.sx + cx, y: win.sy + win.ch + cy };
}

export async function hardwareClickAt(client: CdpClient, ref: string, cg: CgEvent = loadCgEvent()): Promise<void> {
  const target = await resolveScreenCoords(client, ref);
  const tx = jitter(target.x);
  const ty = jitter(target.y);
  for (const p of mouseCurve(cg.getMousePos(), { x: tx, y: ty })) {
    cg.moveMouse(p.x, p.y);
    await sleep(4 + Math.random() * 12);
  }
  await sleep(50 + Math.random() * 150); // settle
  cg.mouseClick();
}

/** OQ-6: typeStringDelayed-style typing goes to OS active-focus → focus first. */
export async function hardwareTypeAt(
  client: CdpClient,
  ref: string,
  text: string,
  cg: CgEvent = loadCgEvent(),
): Promise<void> {
  await hardwareClickAt(client, ref, cg); // focus the element
  // NIT-1: Cmd+A select-all — symmetric keycode for key-down AND key-up.
  const cmd = mapModifiers(4); // Meta (Cmd)
  const aKey = mapKey("A");
  cg.keyEvent(aKey, true, cmd);
  cg.keyEvent(aKey, false, cmd);
  cg.unicodeType(text);
}

export async function hardwareScroll(
  _client: CdpClient,
  direction: string,
  amount: number,
  cg: CgEvent = loadCgEvent(),
): Promise<void> {
  const steps = Math.max(1, Math.ceil(amount / 200));
  const per = Math.round(amount / steps);
  const sign = direction === "up" ? 1 : -1;
  for (let i = 0; i < steps; i++) {
    cg.scrollWheel(0, sign * per);
    await sleep(16 + Math.random() * 20);
  }
}

export function hardwarePressKey(
  _client: CdpClient,
  key: string,
  modifiers: number,
  cg: CgEvent = loadCgEvent(),
): void {
  const code = mapKey(key);
  const flags = mapModifiers(modifiers);
  cg.keyEvent(code, true, flags);
  cg.keyEvent(code, false, flags);
}

/** Resolve the effective input mode ONCE, with graceful CDP downgrade (D-4). */
export function resolveInputMode(
  requested: "cdp" | "hardware",
  deps: { loadCg?: () => CgEvent } = {},
): "cdp" | "hardware" {
  if (requested === "cdp") return "cdp";
  const load = deps.loadCg ?? loadCgEvent;
  let cg: CgEvent;
  try {
    cg = load();
  } catch (e) {
    process.stderr.write(
      `[frondose] input_mode=hardware unavailable (${e instanceof Error ? e.message : e}); using cdp\n`,
    );
    return "cdp";
  }
  if (!cg.isAccessibilityTrusted()) {
    process.stderr.write(
      "[frondose] input_mode=hardware: Accessibility permission not granted (System Settings → Privacy & " +
        "Security → Accessibility); using cdp\n",
    );
    return "cdp";
  }
  return "hardware";
}
