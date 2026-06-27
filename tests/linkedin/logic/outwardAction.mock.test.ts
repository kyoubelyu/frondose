import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { InspectSummary } from "../../../src/linkedin/logic/contracts/inspect.js";
import {
  buildOutwardActionAdvice,
  classifyClickDescriptor,
  classifyTypeDescriptor,
  parseDynamicLabel,
} from "../../../src/linkedin/logic/outwardAction.js";
import type {
  CurrentSurfaceContext,
  SnapshotEntry,
} from "../../../src/linkedin/logic/surface/currentSurfaceTypes.js";

function entry(role: string, name: string, ref = "@e1"): SnapshotEntry {
  return { ref, role, name };
}

function context(options: {
  pageUrl?: string;
  surface?: string;
  entries?: SnapshotEntry[];
  text?: string[];
} = {}): CurrentSurfaceContext {
  const entries = options.entries ?? [entry("heading", "Ada Lovelace")];
  const summary: InspectSummary = {
    surface: options.surface ?? "profile",
    activeLayer: "page",
    availableScopes: [],
    text: options.text ?? [],
    buttons: [],
    inputs: [],
    interactiveRegions: [],
    ambiguityCases: [],
  };

  return {
    pageUrl: options.pageUrl ?? "https://www.linkedin.com/in/ada-lovelace/",
    surface: summary.surface,
    activeLayer: "page",
    entries,
    repeatedControls: [],
    summary,
  };
}

describe("outward action dynamic label parsing", () => {
  it("T-OutwardAction.Parse.1: dynamic follow, invite, and message labels expose action metadata", () => {
    // Given: LinkedIn labels whose person target is embedded in the accessible name.
    // When: parseDynamicLabel normalizes and parses each label.
    // Then: it returns the outward action kind, phase, and normalized person name.
    assert.deepEqual(parseDynamicLabel(" Follow   Grace Hopper "), {
      actionKind: "follow",
      phase: "commit",
      personName: "Grace Hopper",
    });
    assert.deepEqual(parseDynamicLabel("Invite Ada Lovelace to connect"), {
      actionKind: "connect",
      phase: "open",
      personName: "Ada Lovelace",
    });
    assert.deepEqual(parseDynamicLabel("Send a message to Alan Turing"), {
      actionKind: "message",
      phase: "open",
      personName: "Alan Turing",
    });
    assert.deepEqual(parseDynamicLabel("Profile actions"), {});
  });
});

describe("outward action click classification", () => {
  it("T-OutwardAction.Click.1: Post click is classified as outbound post commit", () => {
    // Given: a feed composer Post button.
    // When: classifyClickDescriptor evaluates the click target.
    // Then: it marks the target as an outbound post commit using the identity anchor.
    const classification = classifyClickDescriptor(context({ pageUrl: "https://www.linkedin.com/feed/", surface: "feed" }), {
      label: "Post",
      role: "button",
      scope: "composerModal",
    });

    assert.equal(classification.isOutbound, true);
    assert.equal(classification.actionKind, "post");
    assert.equal(classification.phase, "commit");
    assert.equal(classification.useIdentityAnchor, true);
  });

  it("T-OutwardAction.Click.2: Connect click is classified as outbound connect preflight", () => {
    // Given: a profile page with a bare Connect button.
    // When: classifyClickDescriptor evaluates the click target.
    // Then: it marks the target as an outbound connect opener with profile subject context.
    const classification = classifyClickDescriptor(context(), {
      label: "Connect",
      role: "button",
      scope: "profileView",
    });

    assert.equal(classification.isOutbound, true);
    assert.equal(classification.actionKind, "connect");
    assert.equal(classification.phase, "open");
    assert.equal(classification.personName, "Ada Lovelace");
    assert.equal(classification.profileUrl, "https://www.linkedin.com/in/ada-lovelace/");
  });

  it("T-OutwardAction.Click.3: Send without a note is classified as outbound connect commit", () => {
    // Given: a profile connect prompt with the note-less send button.
    // When: classifyClickDescriptor evaluates the click target.
    // Then: it marks the target as a connect commit that should be remembered.
    const classification = classifyClickDescriptor(context(), {
      label: "Send without a note",
      role: "button",
      scope: "connectPrompt",
    });

    assert.equal(classification.isOutbound, true);
    assert.equal(classification.actionKind, "connect");
    assert.equal(classification.phase, "commit");
    assert.equal(classification.rememberInteraction, "connect");
  });

  it("T-OutwardAction.Click.4: Like and Comment buttons are not outbound commits", () => {
    // Given: benign feed action buttons that may expose outward-looking labels.
    // When: classifyClickDescriptor evaluates each click target.
    // Then: it returns a non-outbound classification for both labels.
    assert.deepEqual(
      classifyClickDescriptor(context({ pageUrl: "https://www.linkedin.com/feed/", surface: "feed" }), {
        label: "Like",
        role: "button",
        scope: "postActions",
      }),
      { isOutbound: false },
    );
    assert.deepEqual(
      classifyClickDescriptor(context({ pageUrl: "https://www.linkedin.com/feed/", surface: "feed" }), {
        label: "Comment",
        role: "button",
        scope: "postActions",
      }),
      { isOutbound: false },
    );
  });
});

describe("outward action type classification", () => {
  it("T-OutwardAction.Type.1: message textbox typing is classified as outbound draft work", () => {
    // Given: a messaging thread composer textbox.
    // When: classifyTypeDescriptor evaluates the type target.
    // Then: it marks the target as outbound message draft work.
    const classification = classifyTypeDescriptor(
      context({ pageUrl: "https://www.linkedin.com/messaging/thread/123/", surface: "messaging-thread" }),
      { label: "Write a message", role: "textbox", scope: "threadInput" },
    );

    assert.equal(classification.isOutbound, true);
    assert.equal(classification.actionKind, "message");
    assert.equal(classification.phase, "draft");
  });
});

describe("outward action advice", () => {
  it("T-OutwardAction.Advice.1: default advice is structured and contains no legacy CLI command string", () => {
    // Given: a connect commit classification without injected persistence or command vocabulary.
    // When: buildOutwardActionAdvice creates advisory records.
    // Then: it emits structured preflight/post-action advice without a legacy CLI command.
    const surfaceContext = context();
    const classification = classifyClickDescriptor(surfaceContext, {
      label: "Send without a note",
      role: "button",
      scope: "connectPrompt",
    });
    const advice = buildOutwardActionAdvice(classification, surfaceContext);
    const legacyCliMarker = ["mai", "linkedin"].join("-");

    assert.ok(advice.some((item) => item.kind === "identity_missing" && item.stage === "preflight"));
    assert.ok(
      advice.some(
        (item) => item.kind === "memory_recommended" && item.stage === "preflight" && item.required === true,
      ),
    );
    assert.ok(advice.some((item) => item.kind === "remember_recommended" && item.stage === "post_action"));
    assert.equal(JSON.stringify(advice).includes(legacyCliMarker), false);
    assert.equal(advice.some((item) => item.suggestedCommand), false);
  });
});
