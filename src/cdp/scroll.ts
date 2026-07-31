export const SCROLL_OBSERVE_MS = 120;

export type ScrollDirection = "up" | "down" | "left" | "right";
export type ScrollAxis = "x" | "y";
export type ScrollNoMovementReason = "no_scroll_range" | "at_requested_boundary" | "movement_blocked";

export interface ScrollCoordinates {
  target: "document";
  axis: ScrollAxis;
  beforeX: number;
  beforeY: number;
  afterX: number;
  afterY: number;
  deltaX: number;
  deltaY: number;
}

export type ScrollOutcome =
  | (ScrollCoordinates & {
      verification: "verified";
      state: "moved";
    })
  | (ScrollCoordinates & {
      verification: "verified";
      state: "not_moved";
      reason: ScrollNoMovementReason;
    })
  | {
      verification: "unavailable";
      state: "unverified";
      target: "hardware";
      axis: ScrollAxis;
    };

/**
 * Build the exact page-side expression used by CdpClient.scroll().
 *
 * The document root is the only target. A nested fallback would need an
 * intent-preserving ownership rule; choosing any movable visible container
 * after a root boundary can scroll an unrelated sidebar.
 */
export function buildDocumentScrollExpression(direction: ScrollDirection, amount: number): string {
  const axis: ScrollAxis = direction === "left" || direction === "right" ? "x" : "y";
  const signedAmount = direction === "up" || direction === "left" ? -amount : amount;

  return `(async () => {
    const root = document.scrollingElement;
    const axis = ${JSON.stringify(axis)};
    const beforeX = Number(root?.scrollLeft ?? 0);
    const beforeY = Number(root?.scrollTop ?? 0);
    const coordinates = (afterX, afterY) => ({
      target: "document",
      axis,
      beforeX,
      beforeY,
      afterX,
      afterY,
      deltaX: afterX - beforeX,
      deltaY: afterY - beforeY,
    });
    if (!root) {
      return {
        verification: "verified",
        state: "not_moved",
        reason: "no_scroll_range",
        ...coordinates(beforeX, beforeY),
      };
    }

    const maxX = Math.max(0, Number(root.scrollWidth) - Number(root.clientWidth));
    const maxY = Math.max(0, Number(root.scrollHeight) - Number(root.clientHeight));
    const range = axis === "x" ? maxX : maxY;
    if (range <= 0) {
      return {
        verification: "verified",
        state: "not_moved",
        reason: "no_scroll_range",
        ...coordinates(beforeX, beforeY),
      };
    }

    const before = axis === "x" ? beforeX : beforeY;
    const requested = before + ${JSON.stringify(signedAmount)};
    const targetPosition = Math.max(0, Math.min(range, requested));
    if (targetPosition === before) {
      return {
        verification: "verified",
        state: "not_moved",
        reason: "at_requested_boundary",
        ...coordinates(beforeX, beforeY),
      };
    }

    if (axis === "x") root.scrollLeft = targetPosition;
    else root.scrollTop = targetPosition;

    const twoFrames = new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    const localBound = new Promise((resolve) => {
      setTimeout(resolve, ${SCROLL_OBSERVE_MS});
    });
    await Promise.race([twoFrames, localBound]);

    const afterX = Number(root.scrollLeft);
    const afterY = Number(root.scrollTop);
    const result = coordinates(afterX, afterY);
    const axisDelta = axis === "x" ? result.deltaX : result.deltaY;
    if (axisDelta !== 0) {
      return { verification: "verified", state: "moved", ...result };
    }
    return {
      verification: "verified",
      state: "not_moved",
      reason: "movement_blocked",
      ...result,
    };
  })()`;
}
