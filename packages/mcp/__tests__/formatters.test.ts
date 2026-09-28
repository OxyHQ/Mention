import { describe, expect, it } from "bun:test";
import { formatNotification, formatPost } from "../lib/formatters.js";

describe("post formatter", () => {
  it("reads viewer-specific engagement only from canonical viewerState", () => {
    const formatted = formatPost({
      id: "post-1",
      content: { text: "Canonical state" },
      viewerState: {
        isLiked: true,
        isBoosted: true,
        isSaved: true,
      },
    });

    expect(formatted).toContain("You: liked, boosted, saved");
  });

  it("does not revive removed root-level viewer flags", () => {
    const formatted = formatPost({
      id: "post-2",
      content: { text: "Legacy state" },
      ...({
        isLiked: true,
        isBoosted: true,
        isSaved: true,
      } as Record<string, boolean>),
    });

    expect(formatted).not.toContain("You:");
  });
});

describe("notification formatter", () => {
  it("names the post a mention is about, so it can be opened or answered", () => {
    const text = formatNotification({
      _id: "n1", type: "mention", read: false, preview: "hola @faircoin",
      actorId_populated: { username: "ana", name: "Ana" }, entityType: "post", entityId: "post-42",
    });
    expect(text).toContain("[n1] @ana (Ana) — mention (unread)");
    expect(text).toContain("post: post-42");
  });

  it("leaves the line out when there is no entity", () => {
    expect(formatNotification({ _id: "n2", type: "welcome" })).not.toContain(": undefined");
  });
});
