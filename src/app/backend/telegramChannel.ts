export type TelegramMedia = {
  kind: string;
  fileId: string;
  fileUniqueId?: string;
};

export type TelegramUpdate = {
  updateId: number;
  text?: string;
  media?: TelegramMedia[];
};

export type TelegramAuditEvent = {
  type: "telegram_inbound" | "telegram_outbound";
  updateId: number;
};

export type TelegramChannelDeps = {
  configured: boolean;
  readOffset(): number;
  commitOffset(offset: number): void;
  pollUpdates(signal: AbortSignal, offset: number): Promise<TelegramUpdate[]>;
  downloadMedia(media: TelegramMedia, signal: AbortSignal): Promise<string>;
  submitTurn(
    input: { source: "telegram"; text: string; media: string[] },
    signal: AbortSignal,
  ): Promise<{ finalText: string }>;
  sendReply(text: string, signal: AbortSignal): Promise<void>;
  writeAudit(event: TelegramAuditEvent): void;
  waitForNextPoll(signal: AbortSignal): Promise<void>;
};

export type TelegramChannel = {
  start(): void;
  pollOnce(): Promise<void>;
  stop(): Promise<void>;
};

export function createTelegramChannel(deps: TelegramChannelDeps): TelegramChannel {
  const lifecycle = new AbortController();
  const inFlight = new Set<Promise<void>>();
  let loop: Promise<void> | undefined;

  const processUpdate = async (update: TelegramUpdate, signal: AbortSignal): Promise<void> => {
    deps.writeAudit({ type: "telegram_inbound", updateId: update.updateId });
    const media: string[] = [];
    for (const item of update.media ?? []) media.push(await deps.downloadMedia(item, signal));
    const result = await deps.submitTurn(
      { source: "telegram", text: update.text ?? "", media },
      signal,
    );
    await deps.sendReply(result.finalText, signal);
    deps.writeAudit({ type: "telegram_outbound", updateId: update.updateId });
    deps.commitOffset(update.updateId + 1);
  };

  const runPoll = async (): Promise<void> => {
    if (!deps.configured || lifecycle.signal.aborted) return;
    const updates = await deps.pollUpdates(lifecycle.signal, deps.readOffset());
    for (const update of updates) {
      if (lifecycle.signal.aborted) return;
      await processUpdate(update, lifecycle.signal);
    }
  };

  const pollOnce = (): Promise<void> => {
    const work = runPoll();
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work)).catch(() => {});
    return work;
  };

  const start = (): void => {
    if (!deps.configured || loop) return;
    loop = (async () => {
      while (!lifecycle.signal.aborted) {
        try {
          await pollOnce();
        } catch {
          if (lifecycle.signal.aborted) break;
        }
        if (!lifecycle.signal.aborted) await deps.waitForNextPoll(lifecycle.signal);
      }
    })();
  };

  const stop = async (): Promise<void> => {
    lifecycle.abort();
    await Promise.allSettled([...(loop ? [loop] : []), ...inFlight]);
  };

  return { start, pollOnce, stop };
}
