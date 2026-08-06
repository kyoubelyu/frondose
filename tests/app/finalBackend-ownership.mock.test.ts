import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";

type SidecarRuntime = {
  start(): Promise<void>;
  submitTurn(input: { source: "ui" | "telegram"; text: string; media: string[] }): Promise<{ finalText: string }>;
  pollTelegramOnce(): Promise<void>;
  stop(): Promise<void>;
  routeNames(): string[];
};

type SidecarModule = {
  createSidecarRuntime(deps: {
    telegramConfigured: boolean;
    pollTelegram: (signal: AbortSignal, offset: number) => Promise<Array<{ updateId: number; text: string }>>;
    sendTelegramReply: (text: string, signal: AbortSignal) => Promise<void>;
    readTelegramOffset: () => number;
    commitTelegramOffset: (offset: number) => void;
    writeAudit: (event: { type: string }) => void;
    releaseResources: () => void;
  }): SidecarRuntime;
};

type TelegramChannelDeps = {
  submitTurn(input: { source: "telegram"; text: string; media: string[] }): Promise<{ finalText: string }>;
};

let telegramFactoryCalls: TelegramChannelDeps[] = [];
let telegramStarts = 0;
let telegramStops = 0;
let telegramPolls = 0;
let nextTelegramText = "telegram";
let telegramLifecycle: string[] | undefined;

const createTelegramChannel = (deps: TelegramChannelDeps) => {
  telegramFactoryCalls.push(deps);
  return {
    start: async () => {
      telegramStarts += 1;
      telegramLifecycle?.push("channel-start");
    },
    pollOnce: async () => {
      telegramPolls += 1;
      await deps.submitTurn({ source: "telegram", text: nextTelegramText, media: [] });
    },
    stop: async () => {
      telegramStops += 1;
      telegramLifecycle?.push("channel-stop");
    },
  };
};

let piHandler: (input: { messages?: Array<{ content?: string }> }) => Promise<{ finalText: string }> = async () => ({
  finalText: "ok",
});
const piUrl = pathToFileURL(join(process.cwd(), "src/agent/pi/loop.js")).href;
mock.module(piUrl, {
  namedExports: {
    runAgentLoopPi: async (input: { messages?: Array<{ content?: string }> }) => piHandler(input),
  },
});

async function loadSidecar(query = ""): Promise<SidecarModule> {
  return (await import(
    `${pathToFileURL(join(process.cwd(), "src/app/sidecarMain.ts")).href}${query}`
  )) as SidecarModule;
}

describe("P-OPEN-SOURCE-SPLIT final App backend ownership", () => {
  // Given final App boot, when its route inventory is requested, then all retained behavior is owned below src/app and no CLI shim is needed.
  it("T-RETIRE.CLI.2a: final boot owns every retained route and scheduler surface", async () => {
    const mod = await loadSidecar();
    const backend = mod.createSidecarRuntime(baseDeps());
    await backend.start();
    assert.deepEqual(backend.routeNames().sort(), [
      "abort",
      "audit",
      "chrome/ensure",
      "cron",
      "events",
      "health",
      "identity",
      "passive",
      "retry",
      "settings",
      "turn",
      "workflow/approve",
      "workflow/cancel",
      "workflow/decline",
    ]);
    await backend.stop();
  });

  // Given an occupied UI turn, when Telegram enters through final boot, then it shares the busy owner and cannot invoke a second Pi loop.
  it("T-RETIRE.Telegram.2: sidecar starts one configured poller and Telegram shares exactly one Pi scheduler", async () => {
    const telegramUrl = pathToFileURL(join(process.cwd(), "src/app/backend/telegramChannel.ts")).href;
    mock.module(telegramUrl, { namedExports: { createTelegramChannel } });
    const mod = await loadSidecar("?telegram-composition");
    telegramFactoryCalls = [];
    telegramStarts = 0;
    telegramStops = 0;
    telegramPolls = 0;
    nextTelegramText = "telegram";
    const configuredOrder: string[] = [];
    telegramLifecycle = configuredOrder;
    let piCalls = 0;
    let releaseUi!: () => void;
    const uiBlocked = new Promise<void>((resolve) => {
      releaseUi = resolve;
    });
    piHandler = async (input) => {
      const text = input.messages?.at(-1)?.content ?? "";
      piCalls += 1;
      if (text === "ui") await uiBlocked;
      return { finalText: text };
    };
    const backend = mod.createSidecarRuntime(
      baseDeps({
        telegramConfigured: true,
        pollTelegram: async () => [{ updateId: 7, text: "telegram" }],
        releaseResources: () => configuredOrder.push("release"),
      }),
    );
    assert.equal(telegramFactoryCalls.length, 1, "configured sidecar constructs exactly one Telegram channel");
    assert.equal(
      telegramFactoryCalls[0]?.submitTurn,
      backend.submitTurn,
      "UI and Telegram receive the exact same scheduler-owned submitTurn function",
    );
    await backend.start();
    assert.equal(telegramStarts, 1, "start() starts the configured Telegram channel");
    const ui = backend.submitTurn({ source: "ui", text: "ui", media: [] });
    await assert.rejects(() => backend.pollTelegramOnce(), /turn_busy/);
    assert.equal(telegramPolls, 1, "sidecar poll hook delegates to the constructed channel");
    assert.equal(piCalls, 1);
    releaseUi();
    await ui;
    await backend.pollTelegramOnce();
    assert.equal(telegramPolls, 2, "no parallel sidecar polling path exists");
    assert.equal(piCalls, 2, "one UI Pi turn plus exactly one deferred Telegram Pi turn");
    await backend.stop();
    assert.equal(telegramStops, 1);
    assert.deepEqual(configuredOrder, ["channel-start", "channel-stop", "release"]);
    telegramFactoryCalls = [];
    telegramStarts = 0;
    telegramStops = 0;
    const order: string[] = [];
    telegramLifecycle = order;
    const unconfigured = mod.createSidecarRuntime(
      baseDeps({ telegramConfigured: false, releaseResources: () => order.push("release") }),
    );
    assert.equal(telegramFactoryCalls.length, 0, "unconfigured sidecar constructs no Telegram transport");
    await unconfigured.start();
    await unconfigured.stop();
    assert.deepEqual(order, ["release"]);
  });
});

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    telegramConfigured: false,
    pollTelegram: async () => [],
    sendTelegramReply: async () => {},
    readTelegramOffset: () => 7,
    commitTelegramOffset: () => {},
    writeAudit: () => {},
    releaseResources: () => {},
    ...overrides,
  } as Parameters<SidecarModule["createSidecarRuntime"]>[0];
}
