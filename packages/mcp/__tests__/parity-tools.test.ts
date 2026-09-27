import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../lib/create-server.js";
import { requestContext } from "../lib/context.js";
import { formatPoll, formatPost } from "../lib/formatters.js";

const originalFetch = globalThis.fetch;

interface CapturedRequest {
  method: string;
  path: string;
  body: unknown;
  headers: Headers;
}

/** Answer every request with `respond(method, path)`, recording what was sent. */
function captureFetch(
  respond: (method: string, path: string) => unknown = () => ({}),
): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    captured.push({
      method,
      path: url.pathname,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers: new Headers(init?.headers),
    });
    return new Response(JSON.stringify(respond(method, url.pathname)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return captured;
}

async function callAs(
  scopes: string[],
  name: string,
  args: Record<string, unknown>,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mention-parity-test", version: "1.0.0" });
  const server = createMcpServer();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return await requestContext.run({
      userToken: "central-token",
      authMode: "central",
      accountId: "account-1",
      clientId: "client-1",
      tokenId: "token-1",
      scopes: new Set(scopes),
    }, () => client.callTool({ name, arguments: args }));
  } finally {
    await client.close();
    await server.close();
  }
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const [first] = result.content as Array<{ type: string; text: string }>;
  return first?.text ?? "";
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * One row per new write tool: the call, and the exact request it must make.
 * Each is sent under only the capability its policy declares, so a tool that
 * reaches for a route outside its grant fails here.
 */
const WRITE_CASES: Array<{
  tool: string;
  scope: string;
  args: Record<string, unknown>;
  method: string;
  path: string;
  body?: unknown;
  /** What the API answers, when the tool reads its response. */
  response?: unknown;
}> = [
  { tool: "unboost", scope: "social.interact", args: { id: "post-1" }, method: "DELETE", path: "/feed/post-1/boost" },
  {
    tool: "move-saved-post-to-folder",
    scope: "social.posts.save",
    args: { id: "post-1", folder: "Reading" },
    method: "PATCH",
    path: "/posts/bookmarks/by-post/post-1/folder",
    body: { folder: "Reading" },
  },
  {
    tool: "move-saved-post-to-folder",
    scope: "social.posts.save",
    args: { id: "post-1", folder: null },
    method: "PATCH",
    path: "/posts/bookmarks/by-post/post-1/folder",
    body: { folder: null },
  },
  { tool: "publish-post-now", scope: "social.posts.publish", args: { id: "draft-1" }, method: "POST", path: "/posts/draft-1/publish" },
  { tool: "pin-post", scope: "social.posts.update", args: { id: "post-1" }, method: "PATCH", path: "/posts/post-1/settings", body: { isPinned: true } },
  { tool: "unpin-post", scope: "social.posts.update", args: { id: "post-1" }, method: "PATCH", path: "/posts/post-1/settings", body: { isPinned: false } },
  {
    tool: "update-post-settings",
    scope: "social.posts.update",
    args: { id: "post-1", replyPermission: ["followers"], quotesDisabled: true },
    method: "PATCH",
    path: "/posts/post-1/settings",
    body: { replyPermission: ["followers"], quotesDisabled: true },
  },
  { tool: "delete-lane", scope: "social.lanes.manage", args: { id: "lane-1" }, method: "DELETE", path: "/lanes/lane-1" },
  { tool: "mute-lane", scope: "social.mutes.manage", args: { id: "lane-2" }, method: "POST", path: "/lanes/lane-2/mute" },
  { tool: "unmute-lane", scope: "social.mutes.manage", args: { id: "lane-2" }, method: "DELETE", path: "/lanes/lane-2/mute" },
  {
    tool: "add-list-members",
    scope: "social.lists.update",
    args: { id: "list-1", userIds: ["user-2"] },
    method: "POST",
    path: "/lists/list-1/members",
    body: { userIds: ["user-2"] },
  },
  {
    tool: "remove-list-members",
    scope: "social.lists.update",
    args: { id: "list-1", userIds: ["user-2"] },
    method: "DELETE",
    path: "/lists/list-1/members",
    body: { userIds: ["user-2"] },
  },
  { tool: "mark-notification-read", scope: "social.notifications.manage", args: { id: "n-1" }, method: "PATCH", path: "/notifications/n-1/read" },
  { tool: "subscribe-to-user", scope: "social.notifications.manage", args: { userId: "user-2" }, method: "POST", path: "/subscriptions/user-2" },
  { tool: "unsubscribe-from-user", scope: "social.notifications.manage", args: { userId: "user-2" }, method: "DELETE", path: "/subscriptions/user-2" },
  {
    tool: "follow-entity",
    scope: "social.follow",
    args: { entityType: "hashtag", entityId: "#bun" },
    method: "POST",
    path: "/entity-follows",
    body: { entityType: "hashtag", entityId: "#bun" },
  },
  {
    tool: "unfollow-entity",
    scope: "social.follow",
    args: { entityType: "list", entityId: "list-9" },
    method: "DELETE",
    path: "/entity-follows",
    body: { entityType: "list", entityId: "list-9" },
  },
  { tool: "poke-user", scope: "social.interact", args: { userId: "user-2" }, method: "POST", path: "/pokes/user-2" },
  { tool: "unpoke-user", scope: "social.interact", args: { userId: "user-2" }, method: "DELETE", path: "/pokes/user-2" },
  { tool: "mute-user", scope: "social.mutes.manage", args: { userId: "user-2" }, method: "POST", path: "/mute", body: { mutedId: "user-2" } },
  { tool: "unmute-user", scope: "social.mutes.manage", args: { userId: "user-2" }, method: "DELETE", path: "/mute/user-2" },
  {
    tool: "mute-word",
    scope: "social.mutes.manage",
    args: { value: "spoilers", actorTarget: "exclude-following" },
    method: "POST",
    path: "/mute-words",
    body: { value: "spoilers", actorTarget: "exclude-following" },
    response: { success: true, data: { id: "word-1", value: "spoilers", targets: ["content", "tag"], actorTarget: "exclude-following" } },
  },
  { tool: "unmute-word", scope: "social.mutes.manage", args: { id: "word-1" }, method: "DELETE", path: "/mute-words/word-1" },
];

describe("new write tools", () => {
  for (const testCase of WRITE_CASES) {
    test(`${testCase.tool} ${testCase.method} ${testCase.path}`, async () => {
      const captured = captureFetch(() => testCase.response ?? {});
      const result = await callAs([testCase.scope], testCase.tool, testCase.args);

      expect(result.isError).toBeFalsy();
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({ method: testCase.method, path: testCase.path });
      if (testCase.body !== undefined) expect(captured[0]?.body).toEqual(testCase.body);
      // Every write is bound to the transport and names its tool, so the API
      // can reserve it once and check the tool owns the route.
      expect(captured[0]?.headers.get("Idempotency-Key")).toMatch(/^mcp:[a-f0-9]{64}$/);
      expect(captured[0]?.headers.get("X-Oxy-MCP-Tool")).toBe(testCase.tool);
    });
  }

  test("refuses a new tool without its capability before calling the API", async () => {
    const captured = captureFetch();
    const result = await callAs(["social.interact"], "mute-user", { userId: "user-2" });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe("This tool requires: social.mutes.manage.");
    expect(captured).toHaveLength(0);
  });

  test("update-post-settings refuses an empty change", async () => {
    const captured = captureFetch();
    const result = await callAs(["social.posts.update"], "update-post-settings", { id: "post-1" });

    expect(result.isError).toBe(true);
    expect(captured).toHaveLength(0);
  });

  test("an API refusal comes back as a tool error", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Boost not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const result = await callAs(["social.interact"], "unboost", { id: "post-1" });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe("API error (404): Boost not found");
  });
});

describe("new read tools", () => {
  test("get-muted-users lists muted ids", async () => {
    const captured = captureFetch(() => ({ mutes: [{ _id: "m-1", mutedId: "user-2", createdAt: "2026-09-01" }], count: 1 }));
    const result = await callAs(["social.mutes.read"], "get-muted-users", {});

    expect(captured[0]).toMatchObject({ method: "GET", path: "/mute" });
    expect(text(result)).toBe("Muted users (1):\n\nuser-2 · since 2026-09-01");
  });

  test("get-muted-words reads the { data } envelope", async () => {
    const captured = captureFetch(() => ({
      data: [{ id: "word-1", value: "spoilers", targets: ["content"], actorTarget: "all" }],
    }));
    const result = await callAs(["social.mutes.read"], "get-muted-words", {});

    expect(captured[0]).toMatchObject({ method: "GET", path: "/mute-words" });
    expect(text(result)).toBe("Muted words (1):\n\nspoilers (id: word-1) · content");
  });

  test("get-muted-lanes names each lane's publisher", async () => {
    const captured = captureFetch(() => ({
      data: [{
        lane: { id: "lane-2", name: "Changelog", displayMode: "tab" },
        owner: { id: "user-2", username: "nate" },
        createdAt: "2026-09-01",
      }],
    }));
    const result = await callAs(["social.mutes.read"], "get-muted-lanes", {});

    expect(captured[0]).toMatchObject({ method: "GET", path: "/lanes/muted" });
    expect(text(result)).toBe("Muted lanes (1):\n\nChangelog (id: lane-2) · tab · by @nate");
  });

  test("get-bookmark-folders lists folder names", async () => {
    const captured = captureFetch(() => ({ folders: ["Reading", "Recipes"] }));
    const result = await callAs(["social.posts.read"], "get-bookmark-folders", {});

    expect(captured[0]).toMatchObject({ method: "GET", path: "/posts/bookmarks/folders" });
    expect(text(result)).toBe("Bookmark folders (2):\n\nReading\nRecipes");
  });
});

describe("polls", () => {
  const poll = {
    _id: "poll-1",
    question: "Tabs or spaces?",
    options: [
      { _id: "opt-a", text: "Tabs", voteCount: 1 },
      { _id: "opt-b", text: "Spaces", voteCount: 3 },
    ],
    createdBy: "user-2",
    endsAt: "2026-10-01T00:00:00.000Z",
    isMultipleChoice: false,
    isAnonymous: false,
    created_at: "",
    updated_at: "",
    viewerSelectedOptionIds: [],
  };

  test("vote-poll sends the option id the route requires", async () => {
    const captured = captureFetch(() => ({ success: true, data: { ...poll, viewerSelectedOptionIds: ["opt-b"] } }));
    const result = await callAs(["social.polls.vote"], "vote-poll", { id: "poll-1", optionId: "opt-b" });

    expect(result.isError).toBeFalsy();
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ method: "POST", path: "/polls/poll-1/vote", body: { optionId: "opt-b" } });
    expect(text(result)).toContain("You have voted.");
  });

  test("vote-poll resolves a zero-based index to that option's id", async () => {
    const captured = captureFetch(() => ({ success: true, data: poll }));
    const result = await callAs(["social.polls.vote", "social.read"], "vote-poll", { id: "poll-1", optionIndex: 1 });

    expect(result.isError).toBeFalsy();
    expect(captured.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /polls/poll-1",
      "POST /polls/poll-1/vote",
    ]);
    expect(captured[1]?.body).toEqual({ optionId: "opt-b" });
  });

  test("vote-poll refuses an index the poll does not have", async () => {
    const captured = captureFetch(() => ({ success: true, data: poll }));
    const result = await callAs(["social.polls.vote", "social.read"], "vote-poll", { id: "poll-1", optionIndex: 5 });

    expect(result.isError).toBe(true);
    expect(captured).toHaveLength(1);
  });

  test("formatPoll reads both the poll and the results shape", () => {
    expect(formatPoll(poll)).toBe([
      "[poll-1] Tabs or spaces?",
      "  1. Tabs — 1 votes (25%) (option id: opt-a)",
      "  2. Spaces — 3 votes (75%) (option id: opt-b)",
      "Total votes: 4",
      "Ends: 2026-10-01T00:00:00.000Z",
    ].join("\n"));
    expect(formatPoll({
      id: "poll-1",
      question: "Tabs or spaces?",
      results: [{ id: "opt-a", text: "Tabs", voteCount: 1, percentage: 25 }],
      totalVotes: 1,
      endsAt: "2026-09-01T00:00:00.000Z",
      isEnded: true,
      isAnonymous: false,
    })).toBe([
      "[poll-1] Tabs or spaces?",
      "  1. Tabs — 1 votes (100%) (option id: opt-a)",
      "Total votes: 1",
      "Ended: 2026-09-01T00:00:00.000Z",
    ].join("\n"));
  });
});

describe("formatPost", () => {
  test("shows the author's user id and the post's lane for the tools that take them", () => {
    const formatted = formatPost({
      id: "post-1",
      user: { id: "user-2", username: "nate", name: { displayName: "Nate" } },
      lane: { id: "lane-2", name: "Changelog" },
      content: { text: "Shipped." },
    });

    expect(formatted).toContain("[post-1] @nate (Nate) · user id: user-2");
    expect(formatted).toContain("Lane: Changelog (id: lane-2)");
  });
});
