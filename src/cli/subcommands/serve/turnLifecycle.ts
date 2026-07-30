export type TurnLifecycleEvent = "accepted" | "aborted";

export function formatTurnLifecycleRecord(event: TurnLifecycleEvent, turnId: string): string {
  return JSON.stringify({ marker: "frondose_turn_lifecycle", event, turnId });
}

export function writeTurnLifecycle(
  event: TurnLifecycleEvent,
  turnId: string,
  write: (line: string) => void = (line) => process.stderr.write(line),
): void {
  write(`${formatTurnLifecycleRecord(event, turnId)}\n`);
}
