/** P-AUTO-11: pure mouse-realism helpers, dep-free.
 *  EXTRACTED from `hardwareInput.ts` (was P-32) so the cdp-arm `clickAt`
 *  in `client.ts` can use them without an import cycle (`hardwareInput.ts`
 *  type-imports `CdpClient` from `client.ts`). Bodies are BYTE-IDENTICAL
 *  to the pre-extraction versions — the existing T-CURVE.1/2 + T-JIT.1
 *  tests (tests/cdp/hardwareCoords.mock.test.ts) are the regression pin.
 *  Both functions use Math.random() — fine in production (the no-random
 *  rule is workflow-script-only). */

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
