import { tool } from "ai";
import { z } from "zod";
import { hardwarePressKey } from "../../cdp/hardwareInput.js";
import { applyPacing, failFromError, ok, withHint } from "../../linkedin/index.js";
import type { LinkedinSession } from "../../linkedin/types.js";

// SPECIAL_KEYS per `references/cli-primitives.md §press`:
//   Enter Tab Escape Backspace Delete Space ArrowUp/Down/Left/Right Home End
//   PageUp PageDown F1..F12
const SPECIAL_KEYS = new Set([
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "Space",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
]);
// State-changing keys emit data.hint per `references/cli-primitives.md §press`:
//   Enter Escape Space F1..F12. Focus-only keys (Tab/arrows/Home/End/Backspace/Delete/modifier
//   combos with non-state-changing base keys) omit the hint.
const STATE_CHANGING_KEYS = new Set([
  "Enter",
  "Escape",
  "Space",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
]);
// Modifier combo: one or more of Control/Alt/Shift/Meta + one special key OR one ASCII letter/digit.
const MODIFIER_PREFIX_RE =
  /^((?:Control|Alt|Shift|Meta)(?:\+(?:Control|Alt|Shift|Meta))*)\+([A-Za-z0-9]|Enter|Tab|Escape|Backspace|Delete|Space|Arrow(?:Up|Down|Left|Right)|Home|End|PageUp|PageDown|F(?:[1-9]|1[0-2]))$/;

function modifierBit(mod: string): number {
  // CDP modifiers bitmask: 1=Alt, 2=Ctrl, 4=Meta, 8=Shift. Combined modifiers OR-ed.
  let bits = 0;
  for (const part of mod.split("+")) {
    if (part === "Alt") bits |= 1;
    else if (part === "Control") bits |= 2;
    else if (part === "Meta") bits |= 4;
    else if (part === "Shift") bits |= 8;
  }
  return bits;
}

/** A modifier+key combo is state-changing iff its base key is in STATE_CHANGING_KEYS. */
function isStateChangingModifierCombo(key: string): boolean {
  const m = key.match(MODIFIER_PREFIX_RE);
  if (!m) return false;
  const baseKey = m[2];
  return baseKey !== undefined && STATE_CHANGING_KEYS.has(baseKey);
}

const pressParams = z.object({
  key: z
    .string()
    .describe(
      "Key to press: a special key (Enter, Tab, Escape, Backspace, Delete, Space, " +
        "ArrowUp/Down/Left/Right, Home, End) OR a modifier combo like 'Control+a', 'Meta+v'.",
    ),
});

export function makePressTool(session: LinkedinSession) {
  return tool({
    description: "Press a key on the focused element of the current LinkedIn page.",
    parameters: pressParams,
    execute: async ({ key }) => {
      try {
        const r = await session.getOrInitClient();
        if (!r.ok) return r;
        const { client } = r;
        const m = key.match(MODIFIER_PREFIX_RE);
        if (m) {
          // biome-ignore lint/style/noNonNullAssertion: regex match guarantees groups 1 and 2.
          const mod = m[1]!;
          // biome-ignore lint/style/noNonNullAssertion: regex match guarantees groups 1 and 2.
          const baseKey = m[2]!;
          const bit = modifierBit(mod);
          // P-32: hardware-path input branch; CDP arm unchanged.
          if (session.inputMode === "hardware") {
            hardwarePressKey(client, baseKey, bit);
          } else {
            await client.handle.Input.dispatchKeyEvent({ type: "keyDown", key: baseKey, modifiers: bit });
            await client.handle.Input.dispatchKeyEvent({ type: "keyUp", key: baseKey, modifiers: bit });
          }
        } else if (SPECIAL_KEYS.has(key)) {
          // P-32: hardware-path input branch; CDP arm unchanged.
          if (session.inputMode === "hardware") hardwarePressKey(client, key, 0);
          else await client.pressKey(key);
        } else {
          throw new Error(
            `press: invalid key '${key}'. Allowed: ${[...SPECIAL_KEYS].join(", ")}, or '<Modifier>+<key>'.`,
          );
        }
        const pacing = await applyPacing();
        const isStateChanging = STATE_CHANGING_KEYS.has(key) || isStateChangingModifierCombo(key);
        const success = ok("press", { key, pressed: true, pacing });
        return isStateChanging ? withHint(success) : success;
      } catch (e) {
        return failFromError("press", e);
      }
    },
  });
}
