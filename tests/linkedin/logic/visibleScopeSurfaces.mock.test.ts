import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CdpClient } from "../../../src/cdp/client.js";
import { captureCurrentSurfaceContext } from "../../../src/linkedin/logic/surface/currentSurface.js";

// NATIVE-PORT SLICE 5 — coverage for the notifications / company /
// companyInbox / article-editor branches of buildVisibleScopeInspections.
// These branches were already lifted verbatim from mai-linkedin during
// Slice 1 (batch cd15c5c) alongside the rest of the classifier, but had no
// dedicated mock coverage — currentSurface.mock.test.ts + surface.mock.test.ts
// only exercised feed/profile/messaging/reaction-modal. This file closes
// that gap; it is test-only (zero production change).

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
  companyInboxMessages?: unknown[];
  activityCommentsDomText?: string[];
}): CdpClient {
  return CdpClient.fromHandle({
    Accessibility: {
      enable: async () => {},
      getFullAXTree: async () => ({
        nodes: options.axEntries.map((entry, index) => axNode(entry, index + 1)),
      }),
    },
    Runtime: {
      evaluate: async (args: { expression: string; returnByValue: boolean; awaitPromise: boolean }) => {
        assert.equal(args.returnByValue, true);
        assert.equal(args.awaitPromise, true);

        if (args.expression === "window.location.href") {
          return { result: { value: options.pageUrl } };
        }

        if (args.expression.includes("org-inbox-message__container")) {
          return { result: { value: JSON.stringify(options.companyInboxMessages ?? []) } };
        }

        if (args.expression.includes("aria-hidden='true'")) {
          return { result: { value: JSON.stringify(options.activityCommentsDomText ?? []) } };
        }

        // extractPostDomPreviews (feed/company post enrichment) and any
        // other unrecognized eval — safe-fail to an empty array.
        return { result: { value: JSON.stringify([]) } };
      },
    },
  });
}

function scopeHandles(context: Awaited<ReturnType<typeof captureCurrentSurfaceContext>>): string[] {
  return context.visibleScopeInspections?.map((inspection) => inspection.scope.handle) ?? [];
}

function scopeByHandle(context: Awaited<ReturnType<typeof captureCurrentSurfaceContext>>, handle: string) {
  return context.visibleScopeInspections?.find((inspection) => inspection.scope.handle === handle);
}

describe("buildVisibleScopeInspections native wiring — remaining surfaces", () => {
  it("T-VisibleScope.Notifications.1: plain notifications page yields the trusted notifications content scope", async () => {
    // Given: a fake CDP client on /notifications/ with ordinary page entries (no company-admin-comments signals).
    // When: captureCurrentSurfaceContext assembles the surface context.
    // Then: it emits topNav + a single "notifications" content scope, with no activityComments scope.
    const client = fakeClient({
      pageUrl: "https://www.linkedin.com/notifications/",
      axEntries: [
        { role: "link", name: "LinkedIn" },
        { role: "link", name: "Home" },
        { role: "heading", name: "New notifications" },
        { role: "button", name: "Mark all as read" },
      ],
    });

    const context = await captureCurrentSurfaceContext(client);

    assert.deepEqual(context.summary.availableScopes.map((scope) => scope.id), ["page", "notificationsView"]);
    assert.deepEqual(scopeHandles(context), ["topNav", "notifications"]);
    const notifications = scopeByHandle(context, "notifications");
    assert.equal(notifications?.scope.kind, "notifications");
  });

  it("T-VisibleScope.Notifications.2: company admin activity-comments page enriches the activityComments scope from DOM text", async () => {
    // Given: a fake CDP client on /company/<id>/admin/notifications/comments/ with a "Respond to X" anchor.
    // When: captureCurrentSurfaceContext assembles the surface context.
    // Then: an "activityComments" scope is emitted with previewText sourced from the DOM extractor.
    const client = fakeClient({
      pageUrl: "https://www.linkedin.com/company/acme/admin/notifications/comments/",
      axEntries: [
        { role: "link", name: "LinkedIn" },
        { role: "link", name: "Home" },
        { role: "heading", name: "Notifications" },
        { role: "img", name: "Jane Doe" },
        { role: "paragraph", name: "Jane Doe commented on your update" },
        { role: "button", name: "Respond to Jane Doe" },
        { role: "button", name: "React Like" },
      ],
      activityCommentsDomText: ["Jane Doe • Congrats on the launch!"],
    });

    const context = await captureCurrentSurfaceContext(client);

    assert.equal(context.surface, "notifications");
    assert.ok(scopeHandles(context).includes("activityComments"));
    const activityComments = scopeByHandle(context, "activityComments");
    assert.equal(activityComments?.scope.kind, "notifications");
    assert.deepEqual(activityComments?.scope.previewText, ["Jane Doe • Congrats on the launch!"]);
  });

  it("T-VisibleScope.Company.1: company page splits into header/actions/content trusted scopes", async () => {
    // Given: a fake CDP client on a company page with a header action and a post boundary marker.
    // When: captureCurrentSurfaceContext assembles the surface context.
    // Then: it emits companyHeader/companyActions/companyContent visible scopes.
    const client = fakeClient({
      pageUrl: "https://www.linkedin.com/company/acme/",
      axEntries: [
        { role: "link", name: "LinkedIn" },
        { role: "link", name: "Home" },
        { role: "heading", name: "Acme Inc" },
        { role: "button", name: "Follow" },
        { role: "button", name: "Open control menu for post by Acme Inc" },
        { role: "heading", name: "Acme Inc" },
        { role: "paragraph", name: "We are hiring!" },
      ],
    });

    const context = await captureCurrentSurfaceContext(client);

    assert.equal(context.surface, "company");
    assert.ok(scopeHandles(context).includes("header"));
    assert.ok(scopeHandles(context).includes("actions"));
    assert.ok(scopeHandles(context).includes("content"));
    assert.equal(scopeByHandle(context, "header")?.scope.kind, "companyHeader");
    assert.equal(scopeByHandle(context, "actions")?.scope.kind, "companyActions");
    assert.equal(scopeByHandle(context, "content")?.scope.kind, "companyContent");
    assert.deepEqual(
      scopeByHandle(context, "actions")?.controls.map((control) => control.label),
      ["Follow"],
    );
  });

  it("T-VisibleScope.CompanyInbox.1: company admin inbox thread page yields a companyInboxThread scope from DOM messages", async () => {
    // Given: a fake CDP client on /company/<id>/admin/inbox/thread/<urn>/ with one admin message in the DOM.
    // When: captureCurrentSurfaceContext assembles the surface context.
    // Then: it emits a companyInboxThread scope whose previewText is the formatted message line.
    const client = fakeClient({
      pageUrl: "https://www.linkedin.com/company/acme/admin/inbox/thread/urn123/",
      axEntries: [
        { role: "link", name: "LinkedIn" },
        { role: "link", name: "Home" },
      ],
      companyInboxMessages: [
        { isAdmin: true, sender: "Acme Admin", body: "Thanks for reaching out!", timestamp: "2h" },
      ],
    });

    const context = await captureCurrentSurfaceContext(client);

    assert.deepEqual(context.summary.availableScopes.map((scope) => scope.id), [
      "page",
      "companyView",
      "companyInboxThread",
    ]);
    assert.ok(scopeHandles(context).includes("companyInboxThread"));
    const thread = scopeByHandle(context, "companyInboxThread");
    assert.equal(thread?.scope.kind, "companyInboxThread");
    assert.deepEqual(thread?.scope.previewText, ["[You – Acme Admin] Thanks for reaching out! (2h)"]);
  });

  it("T-VisibleScope.ArticleEditor.1: article editor page yields header/editor/editorInput visible scopes", async () => {
    // Given: a fake CDP client on /article/new/ with title + body inputs and editor chrome.
    // When: captureCurrentSurfaceContext assembles the surface context.
    // Then: it emits articleHeader/articleEditor/articleEditorInput visible scopes.
    const client = fakeClient({
      pageUrl: "https://www.linkedin.com/article/new/",
      axEntries: [
        { role: "link", name: "LinkedIn" },
        { role: "link", name: "Home" },
        { role: "button", name: "Style" },
        { role: "textbox", name: "Title" },
        { role: "textbox", name: "Article editor content" },
      ],
    });

    const context = await captureCurrentSurfaceContext(client);

    assert.equal(context.surface, "article-editor");
    assert.ok(scopeHandles(context).includes("articleHeader"));
    assert.ok(scopeHandles(context).includes("articleEditor"));
    assert.ok(scopeHandles(context).includes("articleEditorInput"));
    assert.deepEqual(
      scopeByHandle(context, "articleEditorInput")?.controls.map((control) => control.label),
      ["Title", "Article editor content"],
    );
  });
});
