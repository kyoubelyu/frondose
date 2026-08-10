import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CdpClient } from "../../../src/cdp/client.js";

describe("CdpClient native-port primitives", () => {
  it("T-CdpNative.1: navigate(url) dispatches Page.navigate and waits for load", async () => {
    // Given: a fake CDP Page domain that records navigation calls and fires load.
    // When: navigate(url) is called on a stealth-marked client.
    // Then: Page.navigate receives the URL and the load waiter is installed.
    const calls: string[] = [];
    let navigatedUrl: string | undefined;

    const client = CdpClient.fromHandle({
      Page: {
        enable: async () => {
          calls.push("Page.enable");
        },
        navigate: async (args: { url: string }) => {
          calls.push("Page.navigate");
          navigatedUrl = args.url;
          // loaderId present: real cross-document navigation (CDP omits it only for
          // same-document navigation; the 5a fix skips the load wait in that case).
          return { loaderId: "L1" };
        },
        loadEventFired: (callback: () => void) => {
          calls.push("Page.loadEventFired");
          callback();
          return () => {
            calls.push("Page.loadEventFired.unsubscribe");
          };
        },
      },
    });
    client.markStealthInjected();

    await client.navigate("https://www.linkedin.com/feed/");

    assert.equal(navigatedUrl, "https://www.linkedin.com/feed/");
    // [5a] The load-event subscription now happens BEFORE Page.navigate (subscribe-first
    // removes the missed-event stall on same-URL/cache-warm navigations).
    assert.deepEqual(calls.slice(0, 3), ["Page.enable", "Page.loadEventFired", "Page.navigate"]);
  });

  it("T-CdpNative.2: getElementText(selector) evaluates querySelector text readback", async () => {
    // Given: a fake Runtime.evaluate returning visible text.
    // When: getElementText(selector) is called.
    // Then: the expression queries the selector and returns the evaluated text.
    const expressions: string[] = [];
    const client = CdpClient.fromHandle({
      Runtime: {
        evaluate: async (args: { expression: string; returnByValue: boolean; awaitPromise: boolean }) => {
          expressions.push(args.expression);
          assert.equal(args.returnByValue, true);
          assert.equal(args.awaitPromise, true);
          return { result: { value: "Visible label" } };
        },
      },
    });

    const value = await client.getElementText("[data-test='composer']");

    assert.equal(value, "Visible label");
    assert.equal(expressions.length, 1);
    assert.match(expressions[0]!, /document\.querySelector\("\[data-test='composer'\]"\)/);
    assert.match(expressions[0]!, /innerText \|\| el\.textContent/);
  });

  it("T-CdpNative.3: getInputValue(selector) evaluates querySelector value readback", async () => {
    // Given: a fake Runtime.evaluate returning an input value.
    // When: getInputValue(selector) is called.
    // Then: the expression queries the selector and returns the evaluated value.
    const expressions: string[] = [];
    const client = CdpClient.fromHandle({
      Runtime: {
        evaluate: async (args: { expression: string; returnByValue: boolean; awaitPromise: boolean }) => {
          expressions.push(args.expression);
          assert.equal(args.returnByValue, true);
          assert.equal(args.awaitPromise, true);
          return { result: { value: "Typed value" } };
        },
      },
    });

    const value = await client.getInputValue("textarea.compose");

    assert.equal(value, "Typed value");
    assert.equal(expressions.length, 1);
    assert.match(expressions[0]!, /document\.querySelector\("textarea\.compose"\)/);
    assert.match(expressions[0]!, /"value" in el/);
  });
});
