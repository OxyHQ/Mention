import { describe, expect, test } from "bun:test";
import {
  buildFeedDescriptor,
  isValidFeedDescriptor,
  parseFeedDescriptor,
} from "../src/mtn/feedDescriptor";

describe("feed descriptors", () => {
  test("accepts simple and fully-qualified descriptors", () => {
    expect(isValidFeedDescriptor("following")).toBe(true);
    expect(isValidFeedDescriptor("author|user-1")).toBe(true);
    expect(isValidFeedDescriptor("author|user-1|replies")).toBe(true);
    // Every profile tab must resolve to an author descriptor, and `videos` is a
    // tab — served by its own server-side filter, not by the `media` feed.
    expect(isValidFeedDescriptor("author|user-1|videos")).toBe(true);
    expect(isValidFeedDescriptor("hashtag|typescript")).toBe(true);
  });

  test("rejects missing, extra and invalid parameters", () => {
    expect(isValidFeedDescriptor("author")).toBe(false);
    expect(isValidFeedDescriptor("author||posts")).toBe(false);
    expect(isValidFeedDescriptor("author|user-1|unknown")).toBe(false);
    expect(isValidFeedDescriptor("following|arbitrary")).toBe(false);
    expect(isValidFeedDescriptor("custom|")).toBe(false);
    expect(isValidFeedDescriptor("custom|one|two")).toBe(false);
    expect(isValidFeedDescriptor("unknown")).toBe(false);
  });

  test("builds only descriptors that satisfy the runtime contract", () => {
    const descriptor = buildFeedDescriptor("author", "user-1", "media");
    expect(descriptor).toBe("author|user-1|media");
    expect(parseFeedDescriptor(descriptor)).toEqual({
      source: "author",
      params: ["user-1", "media"],
    });

    expect(() => buildFeedDescriptor("author")).toThrow(
      "Invalid feed descriptor",
    );
  });
});
