import { describe, expect, it } from "bun:test";
import { formatPost } from "../lib/formatters.js";

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
