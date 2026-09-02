import { describe, expect, test } from "bun:test";
import {
  MENTION_TOOL_POLICIES,
  mentionCapabilityRequirementsForRequest,
} from "../src/mcpCapabilities";

describe("Mention MCP capability routes", () => {
  test("matches literal and parameterized domain invocations", () => {
    expect(mentionCapabilityRequirementsForRequest("post", "/posts/abc/like"))
      .toEqual([{
        toolName: "like-post",
        requiredCapabilities: ["social.interact"],
      }]);
    expect(mentionCapabilityRequirementsForRequest("GET", "/notifications/unread-count"))
      .toEqual([{
        toolName: "get-unread-count",
        requiredCapabilities: ["social.notifications.read"],
      }]);
  });

  test("returns every valid requirement when tools deliberately share a route", () => {
    expect(mentionCapabilityRequirementsForRequest("GET", "/feed/item/post-1"))
      .toEqual([
        { toolName: "get-feed-item", requiredCapabilities: ["social.read"] },
        { toolName: "get-post", requiredCapabilities: ["social.posts.read"] },
      ]);
  });

  test("does not widen unknown methods, suffixes or routes", () => {
    expect(mentionCapabilityRequirementsForRequest("POST", "/notifications/unread-count"))
      .toEqual([]);
    expect(mentionCapabilityRequirementsForRequest("GET", "/notifications/unread-count/extra"))
      .toEqual([]);
    expect(mentionCapabilityRequirementsForRequest("GET", "/admin"))
      .toEqual([]);
  });

  test("keeps all 59 tool policies in the one shared registry", () => {
    expect(Object.keys(MENTION_TOOL_POLICIES)).toHaveLength(59);
  });
});
