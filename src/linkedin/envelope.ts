import {
  type CommandCandidate,
  type CommandEnvelope,
  type CommandFailure,
  type CommandSuccess,
  type FailureKind,
  SURFACE_CHANGED_HINT,
} from "./types.js";

/** Build a success envelope. Add `withHint` to attach the state-change advisory. */
export function ok<T extends Record<string, unknown>>(command: string, data: T): CommandSuccess<T> {
  return { ok: true, command, data };
}

/** Build a failure envelope. */
export function fail(
  command: string,
  kind: FailureKind,
  message: string,
  candidates?: CommandCandidate[],
): CommandFailure {
  const error: CommandFailure["error"] = { kind, message };
  if (candidates && candidates.length > 0) error.candidates = candidates;
  return { ok: false, command, error };
}

/** Attach `data.hint` to a success envelope. State-changing primitives only. */
export function withHint<T extends Record<string, unknown>>(
  envelope: CommandSuccess<T>,
): CommandSuccess<T & { hint: string }> {
  return {
    ...envelope,
    data: { ...envelope.data, hint: SURFACE_CHANGED_HINT } as T & { hint: string },
  };
}

/** Translate a thrown Error from CdpClient/etc. into a failure envelope. */
export function failFromError(command: string, e: unknown): CommandFailure {
  const message = e instanceof Error ? e.message : String(e);
  // Heuristic kind selection based on message content; tools may override.
  let kind: FailureKind = "runtime_error";
  if (/not found|no match for|matched no element|no upload trigger|no <input/i.test(message)) {
    kind = "not_found";
  } else if (/ambiguous/i.test(message)) {
    kind = "ambiguous_target";
  } else if (/invalid|case.sensitive|empty provider|empty modelId/i.test(message)) {
    kind = "invalid_input";
  }
  return fail(command, kind, message);
}

export type { CommandEnvelope };
