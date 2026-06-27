import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CdpClient } from "../../../src/cdp/client.js";
import { captureCurrentSurfaceContext } from "../../../src/linkedin/logic/surface/currentSurface.js";

interface AxFixtureNode {
  role: string;
  name: string;
}

function axNode(entry: AxFixtureNode, index: number) {
  return {
    nodeId: String(index),
    backendDOMNodeId: index,
    role: { type: "role", value: entry.role },
    name: { type: "computedString", value: entry.name },
  };
}

function fakeClient(options: {
  pageUrl: string;
  axEntries: AxFixtureNode[];
  postDomPreviews?: Array<{ menuLabel: string; text: string[]; actorName?: string }>;
}): { client: CdpClient; expressions: string[] } {
  const expressions: string[] = [];
  const client = CdpClient.fromHandle({
    Accessibility: {
      enable: async () => {},
      getFullAXTree: async () => ({
        nodes: options.axEntries.map((entry, index) => axNode(entry, index + 1)),
      }),
    },
    Runtime: {
      evaluate: async (args: { expression: string; returnByValue: boolean; awaitPromise: boolean }) => {
        expressions.push(args.expression);
        assert.equal(args.returnByValue, true);
        assert.equal(args.awaitPromise, true);

        if (args.expression === "window.location.href") {
          return { result: { value: options.pageUrl } };
        }

        if (args.expression.includes('const SURFACE = "feed"')) {
          return { result: { value: JSON.stringify(options.postDomPreviews ?? []) } };
        }

        return { result: { value: JSON.stringify([]) } };
      },
    },
  });

  return { client, expressions };
}

function scopeHandles(context: Awaited<ReturnType<typeof captureCurrentSurfaceContext>>): string[] {
  return context.visibleScopeInspections?.map((inspection) => inspection.scope.handle) ?? [];
}

describe("captureCurrentSurfaceContext native surface assembly", () => {
  it("T-CurrentSurface.1: feed page with composer and a post yields foreground summary plus visible scopes", async () => {
    // Given: a fake CDP client on the LinkedIn feed with a composer launcher and one post anchor.
    // When: captureCurrentSurfaceContext assembles the surface context.
    // Then: it returns feed foreground state, normalized AX refs, and post/composer visible scopes.
    const { client, expressions } = fakeClient({
      pageUrl: "https://www.linkedin.com/feed/",
      axEntries: [
        { role: "link", name: "LinkedIn" },
        { role: "link", name: "Home" },
        { role: "button", name: "Start a post" },
        { role: "button", name: "Photo" },
        { role: "button", name: "Video" },
        { role: "button", name: "Open control menu for post by Ada Lovelace" },
        { role: "heading", name: "Ada Lovelace" },
        { role: "button", name: "Open reactions menu" },
        { role: "button", name: "Comment" },
        { role: "button", name: "Repost" },
      ],
      postDomPreviews: [
        {
          menuLabel: "Open control menu for post by Ada Lovelace",
          actorName: "Ada Lovelace",
          text: ["Post actor: Ada Lovelace", "Rendered context: Analytical engine update"],
        },
      ],
    });

    const context = await captureCurrentSurfaceContext(client);

    assert.equal(context.pageUrl, "https://www.linkedin.com/feed/");
    assert.equal(context.surface, "feed");
    assert.equal(context.activeLayer, "page");
    assert.equal(context.entries[0]?.ref, "@e1");
    assert.ok(context.entries.some((entry) => entry.name === "Start a post"));
    assert.deepEqual(
      context.summary.availableScopes.map((scope) => scope.id),
      ["page", "feed", "post", "postActions"],
    );
    assert.ok(scopeHandles(context).includes("composer"));
    assert.ok(scopeHandles(context).includes("post:1"));
    assert.deepEqual(
      context.visibleScopeInspections?.find((inspection) => inspection.scope.handle === "post:1")?.scope.previewText,
      ["Post actor: Ada Lovelace", "Rendered context: Analytical engine update"],
    );
    assert.ok(expressions.some((expression) => expression.includes('const SURFACE = "feed"')));
  });

  it("T-CurrentSurface.2: profile page yields profile summary and header/action visible scopes", async () => {
    // Given: a fake CDP client on a LinkedIn profile with subject action buttons.
    // When: captureCurrentSurfaceContext assembles the surface context.
    // Then: it returns the profile page surface with profile action controls.
    const { client } = fakeClient({
      pageUrl: "https://www.linkedin.com/in/ada-lovelace/",
      axEntries: [
        { role: "link", name: "LinkedIn" },
        { role: "link", name: "Home" },
        { role: "heading", name: "Ada Lovelace" },
        { role: "button", name: "Message" },
        { role: "button", name: "Connect" },
        { role: "button", name: "More" },
        { role: "paragraph", name: "Inventor of the first computer program." },
      ],
    });

    const context = await captureCurrentSurfaceContext(client);

    assert.equal(context.pageUrl, "https://www.linkedin.com/in/ada-lovelace/");
    assert.equal(context.surface, "profile");
    assert.equal(context.activeLayer, "page");
    assert.ok(context.summary.availableScopes.some((scope) => scope.id === "profileView"));
    const actions = context.visibleScopeInspections?.find((inspection) => inspection.scope.handle === "actions");
    assert.ok(actions, "profile actions visible scope must be emitted");
    assert.deepEqual(
      actions.controls.map((control) => control.label),
      ["Message", "Connect", "More"],
    );
  });
});
