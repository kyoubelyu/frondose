import type { CdpClient } from "../../cdp/client.js";
import { computeCharDelay } from "../../tools/browser/type.js";
import { LINKEDIN_FIXED_DESTINATIONS } from "../destinations.js";
import {
  isLinkedInAuthInterruptionUrl,
  isSupportedLinkedInSurfaceUrl,
  linkedInAuthInterruptionMessage,
} from "../logic/linkedinUrl.js";
import {
  COMPOSER_CLEAR_JS,
  COMPOSER_EDITOR_JS,
  COMPOSER_FOCUS_JS,
  COMPOSER_POST_BUTTON_ENABLED_JS,
  COMPOSER_PRESENT_JS,
  DEFAULT_COMPOSER_LABEL_PATTERN,
} from "../logic/predicates/composer.js";
import { CONNECT_PROMPT_PRESENT_JS } from "../logic/predicates/connectPrompt.js";
import { scopeIsAvailable } from "../logic/scopeResolver/normalize.js";
import { CommandNotFoundError, type ResolvedTarget } from "../logic/scopeResolver/shared.js";
import { resolveScopedTarget } from "../logic/scopeResolver/targetResolution.js";
import type { CurrentSurfaceContext } from "../logic/surface/currentSurfaceTypes.js";
import { normalizeForComparison, textsMatch } from "../logic/verification.js";

const SETTLE_AFTER_NAV_MS = 300;
const INPUT_READY_SETTLE_MS = 90;
const TARGET_READY_SETTLE_MS = 90;
const READBACK_RETRY_MS = 120;
export const COMPOSER_OPEN_RETRY_ROUNDS = 4;
export const OPEN_IN_ROUND_PROBE_ATTEMPTS = 3;
export const ENABLE_GATE_ATTEMPTS = 6;
export const COMPOSER_GONE_ATTEMPTS = 6;
export const OPEN_PROBE_BASE_MS = 120;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type LinkedInDestination = keyof typeof LINKEDIN_FIXED_DESTINATIONS;

export interface EnsureLinkedInDestinationResult {
  url: string;
  reusedSession: boolean;
}

export interface OpenComposerResult {
  opened: boolean;
  openedOnRound: number;
  everClicked: boolean;
  contextAtOpen?: CurrentSurfaceContext;
}

export async function ensureLinkedInDestination(
  client: CdpClient,
  dest: LinkedInDestination,
): Promise<EnsureLinkedInDestinationResult> {
  const currentUrl = await client.getCurrentUrl();
  if (isLinkedInAuthInterruptionUrl(currentUrl)) {
    throw new Error(linkedInAuthInterruptionMessage(currentUrl));
  }

  const targetPrefix = LINKEDIN_FIXED_DESTINATIONS[dest];
  if (!targetPrefix) {
    throw new Error(`Unknown LinkedIn destination: ${String(dest)}`);
  }
  if (currentUrl.startsWith(targetPrefix) && isSupportedLinkedInSurfaceUrl(currentUrl)) {
    await sleep(SETTLE_AFTER_NAV_MS);
    return { url: currentUrl, reusedSession: true };
  }

  await client.navigate(targetPrefix);
  await sleep(SETTLE_AFTER_NAV_MS);
  const after = await client.getCurrentUrl();
  if (isLinkedInAuthInterruptionUrl(after)) {
    throw new Error(linkedInAuthInterruptionMessage(after));
  }
  return { url: after, reusedSession: false };
}

export class FillFailedError extends Error {
  override readonly cause: "focus_failed" | "clear_failed";

  constructor(cause: "focus_failed" | "clear_failed") {
    super(`fillComposerSurface failed: ${cause}`);
    this.name = "FillFailedError";
    this.cause = cause;
  }
}

export async function fillComposerSurface(client: CdpClient, labelPattern: RegExp, text: string): Promise<void> {
  const focused = await client.evaluate<boolean>(COMPOSER_FOCUS_JS(labelPattern));
  if (focused !== true) throw new FillFailedError("focus_failed");

  const cleared = await client.evaluate<boolean>(COMPOSER_CLEAR_JS(labelPattern));
  if (cleared !== true) throw new FillFailedError("clear_failed");

  let prevChar: string | undefined;
  let elapsed = 0;
  for (const ch of text) {
    if (ch === "\n") {
      await client.raceHandle(
        client.handle.Input.dispatchKeyEvent({
          type: "keyDown",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
        }),
        "Input.keyDown",
      );
      await client.raceHandle(
        client.handle.Input.dispatchKeyEvent({
          type: "keyUp",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
        }),
        "Input.keyUp",
      );
    } else {
      await client.raceHandle(client.handle.Input.insertText({ text: ch }), "Input.insertText");
    }

    const raw = computeCharDelay(text.length, Math.random(), prevChar);
    const delay = Math.min(raw, Math.max(0, 8000 - elapsed));
    elapsed += delay;
    await sleep(delay);
    prevChar = ch;
  }
}

export async function verifyTypedTextOnSameTarget(
  client: CdpClient,
  labelPattern: RegExp,
  intended: string,
): Promise<boolean> {
  const probe = async (): Promise<string> => {
    const raw = await client.evaluate<string>(COMPOSER_EDITOR_JS(labelPattern));
    const parsed = JSON.parse(raw) as { present?: boolean; editorText?: string };
    return parsed.present === true && typeof parsed.editorText === "string" ? parsed.editorText : "";
  };

  if (textsMatch(intended, await probe())) return true;
  await sleep(READBACK_RETRY_MS);
  return textsMatch(intended, await probe());
}

export async function openComposerHardened(deps: {
  client: CdpClient;
  capture: () => Promise<CurrentSurfaceContext>;
}): Promise<OpenComposerResult> {
  const initial = await deps.capture();
  if (initial.activeLayer === "modal" && scopeIsAvailable(initial, "composerInput")) {
    return { opened: true, openedOnRound: 0, everClicked: false, contextAtOpen: initial };
  }

  let everClicked = false;
  for (let round = 0; round < COMPOSER_OPEN_RETRY_ROUNDS; round += 1) {
    let clickedThisRound = false;
    try {
      const opened = await resolveScopedTarget(
        { kind: "button", label: "Start a post" },
        { captureCurrentSurfaceContext: deps.capture },
      );
      await deps.client.clickAt(opened.target.selector);
      clickedThisRound = true;
      everClicked = true;
    } catch {
      clickedThisRound = false;
    }

    if (clickedThisRound) {
      for (let attempt = 0; attempt < OPEN_IN_ROUND_PROBE_ATTEMPTS; attempt += 1) {
        await sleep(OPEN_PROBE_BASE_MS * (attempt + 1));
        const probe = await deps.capture();
        if (probe.activeLayer === "modal" && scopeIsAvailable(probe, "composerInput")) {
          return {
            opened: true,
            openedOnRound: round + 1,
            everClicked: true,
            contextAtOpen: probe,
          };
        }
      }
    }

    if (round < COMPOSER_OPEN_RETRY_ROUNDS - 1) {
      await sleep(OPEN_PROBE_BASE_MS * (1 << round));
    }
  }

  return { opened: false, openedOnRound: -1, everClicked };
}

export async function waitForPostButtonEnabled(client: CdpClient): Promise<{ enabled: boolean; attempts: number }> {
  let attempts = 0;
  for (let i = 0; i < ENABLE_GATE_ATTEMPTS; i += 1) {
    attempts = i + 1;
    let enabled = false;
    try {
      enabled = (await client.evaluate<boolean>(COMPOSER_POST_BUTTON_ENABLED_JS())) === true;
    } catch {
      enabled = false;
    }
    if (enabled) return { enabled: true, attempts };
    if (i < ENABLE_GATE_ATTEMPTS - 1) {
      await sleep(OPEN_PROBE_BASE_MS * (1 << i));
    }
  }
  return { enabled: false, attempts };
}

export async function confirmComposerGone(client: CdpClient): Promise<{ gone: boolean; attempts: number }> {
  let attempts = 0;
  for (let i = 0; i < COMPOSER_GONE_ATTEMPTS; i += 1) {
    attempts = i + 1;
    let present = true;
    try {
      const raw = await client.evaluate<string>(COMPOSER_PRESENT_JS());
      const parsed = JSON.parse(raw) as { present?: boolean };
      present = parsed.present === true;
    } catch {
      present = true;
    }
    if (!present) return { gone: true, attempts };
    if (i < COMPOSER_GONE_ATTEMPTS - 1) {
      await sleep(OPEN_PROBE_BASE_MS * (1 << i));
    }
  }
  return { gone: false, attempts };
}

export async function confirmConnectPromptGone(client: CdpClient): Promise<{ gone: boolean; attempts: number }> {
  let attempts = 0;
  for (let i = 0; i < COMPOSER_GONE_ATTEMPTS; i += 1) {
    attempts = i + 1;
    let present = true;
    try {
      const raw = await client.evaluate<string>(CONNECT_PROMPT_PRESENT_JS());
      const parsed = JSON.parse(raw) as { present?: boolean };
      present = parsed.present === true;
    } catch {
      present = true;
    }
    if (!present) return { gone: true, attempts };
    if (i < COMPOSER_GONE_ATTEMPTS - 1) {
      await sleep(OPEN_PROBE_BASE_MS * (1 << i));
    }
  }
  return { gone: false, attempts };
}

export async function ensureInputReady(context: CurrentSurfaceContext, _target: ResolvedTarget): Promise<void> {
  if (context.activeLayer !== "modal") {
    throw new CommandNotFoundError(
      `ensureInputReady: composer input requires modal layer (activeLayer=${context.activeLayer})`,
    );
  }
  await sleep(INPUT_READY_SETTLE_MS);
}

export async function ensureTargetReady(context: CurrentSurfaceContext, _target: ResolvedTarget): Promise<void> {
  if (context.activeLayer !== "modal") {
    throw new CommandNotFoundError(
      `ensureTargetReady: Post button requires modal layer (activeLayer=${context.activeLayer})`,
    );
  }
  await sleep(TARGET_READY_SETTLE_MS);
}

export { DEFAULT_COMPOSER_LABEL_PATTERN, normalizeForComparison };
