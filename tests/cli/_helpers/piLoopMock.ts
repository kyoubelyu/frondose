import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mock } from "node:test";
import { pathToFileURL } from "node:url";
import type { AgentLoopOpts } from "../../../src/agent/loop.js";

export type PiLoopScript = (opts: AgentLoopOpts, callIndex: number) => Promise<void>;

const PI_LOOP_PATH = "src/agent/pi/loop.js";
const PI_MODEL_PATH = "src/agent/pi/model.js";
const RESOLVER_SENTINEL = new Error("unexpected configured Pi resolver reach");
const NETWORK_SENTINEL = new Error("unexpected network reach from controlled Pi test");

export function appendAssistant(opts: AgentLoopOpts, text = "done"): void {
  opts.messages.push({ role: "assistant", content: text });
}

export function createPiLoopMock() {
  const scripts: PiLoopScript[] = [];
  const calls: AgentLoopOpts[] = [];
  const originalFetch = globalThis.fetch;
  let installed = false;
  let resolverCalls = 0;
  let networkCalls = 0;

  return {
    calls,
    installedTargets(): string[] {
      return installed ? [PI_LOOP_PATH, PI_MODEL_PATH] : [];
    },
    install(): void {
      assert.equal(installed, false, "controlled Pi mock must install exactly once per test file");
      installed = true;
      mock.module(pathToFileURL(resolve(process.cwd(), PI_MODEL_PATH)).href, {
        namedExports: {
          resolvePiModel: () => {
            resolverCalls++;
            throw RESOLVER_SENTINEL;
          },
        },
      });
      mock.module(pathToFileURL(resolve(process.cwd(), PI_LOOP_PATH)).href, {
        namedExports: {
          runAgentLoopPi: async (opts: AgentLoopOpts) => {
            calls.push(opts);
            const script = scripts.shift();
            assert.ok(script, `unexpected Pi loop call #${calls.length}: no queued script`);
            await script(opts, calls.length);
          },
        },
      });
      globalThis.fetch = (async () => {
        networkCalls++;
        throw NETWORK_SENTINEL;
      }) as typeof fetch;
    },
    queue(...next: PiLoopScript[]): void {
      assert.equal(installed, true, "controlled Pi mock must be installed before scripts are queued");
      scripts.push(...next);
    },
    reset(): void {
      scripts.length = 0;
      calls.length = 0;
      resolverCalls = 0;
      networkCalls = 0;
    },
    assertDrained(expectedCalls: number): void {
      assert.equal(calls.length, expectedCalls, `expected ${expectedCalls} controlled Pi calls; got ${calls.length}`);
      assert.equal(scripts.length, 0, `all queued Pi scripts must be consumed; ${scripts.length} remain`);
      assert.equal(resolverCalls, 0, "configured Pi resolver must remain unreachable");
      assert.equal(networkCalls, 0, "network must remain unreachable");
    },
    restore(): void {
      globalThis.fetch = originalFetch;
    },
  };
}
