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
  DEFAULT_COMPOSER_LABEL_PATTERN,
} from "../logic/predicates/composer.js";
import { CommandNotFoundError, type ResolvedTarget } from "../logic/scopeResolver/shared.js";
import type { CurrentSurfaceContext } from "../logic/surface/currentSurfaceTypes.js";
import { normalizeForComparison, textsMatch } from "../logic/verification.js";

const SETTLE_AFTER_NAV_MS = 300;
const INPUT_READY_SETTLE_MS = 90;
const TARGET_READY_SETTLE_MS = 90;
const READBACK_RETRY_MS = 120;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type LinkedInDestination = keyof typeof LINKEDIN_FIXED_DESTINATIONS;

export interface EnsureLinkedInDestinationResult {
  url: string;
  reusedSession: boolean;
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
