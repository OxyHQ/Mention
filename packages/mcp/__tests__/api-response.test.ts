import { describe, expect, test } from "bun:test";
import { PostVisibility } from "@mention/shared-types/post";
import { normalizeVisibility, unwrapApiResponse } from "../lib/api-response.js";

describe("unwrapApiResponse", () => {
  test("unwraps MTN envelope", () => {
    const data = { items: [{ id: "1" }], hasMore: true };
    expect(unwrapApiResponse({ success: true, data })).toEqual(data);
  });

  test("unwraps post envelope", () => {
    const post = { id: "p1", content: { text: "hi" } };
    expect(unwrapApiResponse({ success: true, post })).toEqual(post);
  });

  test("passes through plain objects", () => {
    const raw = { items: [1] };
    expect(unwrapApiResponse(raw)).toEqual(raw);
  });
});

describe("normalizeVisibility", () => {
  test("maps followers alias", () => {
    expect(normalizeVisibility("followers")).toBe(PostVisibility.FOLLOWERS_ONLY);
  });

  test("maps public", () => {
    expect(normalizeVisibility("public")).toBe(PostVisibility.PUBLIC);
  });
});
