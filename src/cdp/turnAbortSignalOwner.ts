export interface TurnAbortSignalOwner {
  set(signal?: AbortSignal): void;
  clear(owner: AbortSignal): boolean;
  get(): AbortSignal | undefined;
}

export function createTurnAbortSignalOwner(): TurnAbortSignalOwner {
  let current: AbortSignal | undefined;
  return {
    set(signal) {
      current = signal;
    },
    clear(owner) {
      if (current !== owner) return false;
      current = undefined;
      return true;
    },
    get() {
      return current;
    },
  };
}
