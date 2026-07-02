import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createForegroundContext } from "../../../src/linkedin/logic/surface/foregroundContext.js";
import type { SnapshotEntry } from "../../../src/linkedin/types.js";

function entry(role: string, name: string, ref = "@e1"): SnapshotEntry {
  return { ref, role, name };
}

describe("surface foreground context classifier", () => {
  it("T-Surface.Foreground.1: feed URL without AX signals stays on the feed page surface", () => {
    // Given: a LinkedIn feed URL and no modal/thread AX entries.
    // When: createForegroundContext classifies the page.
    // Then: it returns the feed legacy surface with page kind and feed route bucket.
    const context = createForegroundContext("https://www.linkedin.com/feed/", []);

    assert.equal(context.legacySurface, "feed");
    assert.equal(context.kind, "page");
    assert.equal(context.routeBucket, "feed");
    assert.equal(context.activeLayer, "page");
  });

  it("T-Surface.Foreground.2: feed URL with composer input and Post button promotes to composer modal", () => {
    // Given: a feed URL with composer input and modal Post button AX signals.
    // When: createForegroundContext classifies the page.
    // Then: AX signals win over the feed URL and produce the composer modal surface.
    const context = createForegroundContext("https://www.linkedin.com/feed/", [
      entry("textbox", "Text editor for creating content", "@e1"),
      entry("button", "Post", "@e2"),
    ]);

    assert.equal(context.legacySurface, "composer-modal");
    assert.equal(context.kind, "modal");
    assert.equal(context.routeBucket, "feed");
    assert.equal(context.activeLayer, "modal");
  });

  it("T-Surface.Foreground.3: profile URL maps to the profile page surface", () => {
    // Given: a LinkedIn profile URL and ordinary page entries.
    // When: createForegroundContext classifies the page.
    // Then: it returns the profile legacy surface and profile route bucket.
    const context = createForegroundContext("https://www.linkedin.com/in/ada-lovelace/", [
      entry("button", "Message"),
    ]);

    assert.equal(context.legacySurface, "profile");
    assert.equal(context.kind, "page");
    assert.equal(context.routeBucket, "profile");
    assert.equal(context.activeLayer, "page");
  });

  it("T-Surface.Foreground.4: messaging thread URL maps to the active messaging thread layer", () => {
    // Given: a LinkedIn messaging-thread URL.
    // When: createForegroundContext classifies the page.
    // Then: it returns the messaging-thread legacy surface with thread kind and messaging route bucket.
    const context = createForegroundContext("https://www.linkedin.com/messaging/thread/2-abc/", [
      entry("textbox", "Write a message"),
    ]);

    assert.equal(context.legacySurface, "messaging-thread");
    assert.equal(context.kind, "thread");
    assert.equal(context.routeBucket, "messaging");
    assert.equal(context.activeLayer, "thread");
  });

  it("T-Surface.Foreground.5: reaction modal AX signals win over the feed URL", () => {
    // Given: a feed URL with reaction-modal AX controls.
    // When: createForegroundContext classifies the page.
    // Then: it returns the reaction modal surface and modal active layer.
    const context = createForegroundContext("https://www.linkedin.com/feed/", [
      entry("button", "Like", "@e1"),
      entry("button", "Celebrate", "@e2"),
      entry("button", "Support", "@e3"),
    ]);

    assert.equal(context.legacySurface, "reaction-modal");
    assert.equal(context.kind, "modal");
    assert.equal(context.routeBucket, "feed");
    assert.equal(context.activeLayer, "modal");
  });

  it("T-Surface.Foreground.6: notifications URL maps to the notifications route bucket", () => {
    // Given: a LinkedIn notifications URL with ordinary page entries.
    // When: createForegroundContext classifies the page.
    // Then: it returns the notifications legacy surface and notifications route bucket.
    const context = createForegroundContext("https://www.linkedin.com/notifications/", [
      entry("heading", "New notifications"),
    ]);

    assert.equal(context.legacySurface, "notifications");
    assert.equal(context.kind, "page");
    assert.equal(context.routeBucket, "notifications");
    assert.equal(context.activeLayer, "page");
  });

  it("T-Surface.Foreground.7: company URL maps to the company route bucket", () => {
    // Given: a LinkedIn company page URL with ordinary page entries.
    // When: createForegroundContext classifies the page.
    // Then: it returns the company legacy surface and company route bucket.
    const context = createForegroundContext("https://www.linkedin.com/company/acme/", [
      entry("heading", "Acme Inc"),
    ]);

    assert.equal(context.legacySurface, "company");
    assert.equal(context.kind, "page");
    assert.equal(context.routeBucket, "company");
    assert.equal(context.activeLayer, "page");
  });

  it("T-Surface.Foreground.8: company admin inbox thread URL maps to the companyInbox route bucket", () => {
    // Given: a LinkedIn company admin inbox thread URL.
    // When: createForegroundContext classifies the page.
    // Then: the route bucket is companyInbox even though the legacy surface stays "company".
    const context = createForegroundContext(
      "https://www.linkedin.com/company/acme/admin/inbox/thread/urn123/",
      [entry("link", "LinkedIn")],
    );

    assert.equal(context.legacySurface, "company");
    assert.equal(context.kind, "page");
    assert.equal(context.routeBucket, "companyInbox");
    assert.equal(context.activeLayer, "page");
  });

  it("T-Surface.Foreground.9: article editor AX signals on an /article/ URL map to the article-editor surface", () => {
    // Given: an /article/ URL with title + body inputs and editor chrome buttons.
    // When: createForegroundContext classifies the page.
    // Then: it returns the article-editor legacy surface under the articles route bucket.
    const context = createForegroundContext("https://www.linkedin.com/article/new/", [
      entry("button", "Style"),
      entry("textbox", "Title"),
      entry("textbox", "Article editor content"),
    ]);

    assert.equal(context.legacySurface, "article-editor");
    assert.equal(context.kind, "page");
    assert.equal(context.routeBucket, "articles");
    assert.equal(context.activeLayer, "page");
  });
});
