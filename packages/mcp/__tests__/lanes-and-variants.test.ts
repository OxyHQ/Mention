import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../lib/create-server.js";
import { requestContext } from "../lib/context.js";

const originalFetch = globalThis.fetch;

interface CapturedRequest {
  method: string;
  path: string;
  body: unknown;
}

function captureFetch(response: unknown): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    captured.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(response), {
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
  const client = new Client({ name: "mention-lanes-test", version: "1.0.0" });
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

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("language variants and lanes on create-post", () => {
  test("sends variants inside content and laneId on the post", async () => {
    const captured = captureFetch({ success: true, data: { id: "post-1" } });
    const result = await callAs(["social.posts.publish"], "create-post", {
      variants: [
        { tag: "en", text: "Search got faster." },
        { tag: "es", text: "La búsqueda es más rápida." },
      ],
      laneId: "lane-1",
    });

    expect(result.isError).toBeFalsy();
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ method: "POST", path: "/posts" });
    expect(captured[0]?.body).toEqual({
      content: {
        variants: [
          { tag: "en", text: "Search got faster." },
          { tag: "es", text: "La búsqueda es más rápida." },
        ],
      },
      laneId: "lane-1",
    });
  });

  test("refuses text and variants together instead of dropping one body", async () => {
    const captured = captureFetch({});
    const result = await callAs(["social.posts.publish"], "create-post", {
      text: "hello",
      variants: [{ tag: "en", text: "hello" }],
    });

    expect(result.isError).toBe(true);
    expect(captured).toHaveLength(0);
  });

  test("create-thread carries laneId and variants per post", async () => {
    const captured = captureFetch({ success: true, data: { posts: [{ id: "a" }, { id: "b" }] } });
    const result = await callAs(["social.posts.publish"], "create-thread", {
      posts: [
        { content: { variants: [{ tag: "en", text: "One" }, { tag: "es", text: "Uno" }] }, laneId: "lane-1" },
        { content: { text: "Two" }, laneId: "lane-1" },
      ],
    });

    expect(result.isError).toBeFalsy();
    expect(captured[0]?.body).toEqual({
      mode: "thread",
      posts: [
        { content: { variants: [{ tag: "en", text: "One" }, { tag: "es", text: "Uno" }] }, laneId: "lane-1" },
        { content: { text: "Two" }, laneId: "lane-1" },
      ],
    });
  });
});

describe("lane tools", () => {
  test("list-lanes reads the active account's lanes", async () => {
    // GET /lanes/mine answers 200 with `{ data }` — no `success` flag.
    const captured = captureFetch({
      data: [{ id: "lane-1", ownerId: "account-1", name: "Updates", displayMode: "tab", postCount: 3, createdAt: "", updatedAt: "" }],
    });
    const result = await callAs(["social.lanes.read"], "list-lanes", {});

    expect(result.isError).toBeFalsy();
    expect(captured[0]).toMatchObject({ method: "GET", path: "/lanes/mine" });
    expect(result.content).toContainEqual({
      type: "text",
      text: "Lanes (1):\n\nUpdates (id: lane-1) · tab · 3 posts",
    });
  });

  test("create-lane posts the name and display mode", async () => {
    const captured = captureFetch({
      success: true,
      data: { id: "lane-2", ownerId: "account-1", name: "Updates", displayMode: "tab", postCount: 0, createdAt: "", updatedAt: "" },
    });
    const result = await callAs(["social.lanes.manage"], "create-lane", { name: "Updates", displayMode: "tab" });

    expect(result.isError).toBeFalsy();
    expect(captured[0]).toMatchObject({ method: "POST", path: "/lanes", body: { name: "Updates", displayMode: "tab" } });
  });

  test("update-lane reads the 200 envelope the route answers with", async () => {
    captureFetch({ data: { id: "lane-1", ownerId: "account-1", name: "Changelog", displayMode: "tab", createdAt: "", updatedAt: "" } });
    const result = await callAs(["social.lanes.manage"], "update-lane", { id: "lane-1", name: "Changelog" });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContainEqual({ type: "text", text: "Lane updated.\n\nChangelog (id: lane-1) · tab" });
  });

  test("move-post-to-lane names the lane the post moved to", async () => {
    captureFetch({ data: { postId: "post-1", lane: { id: "lane-1", name: "Changelog", displayMode: "tab" } } });
    const result = await callAs(["social.posts.update"], "move-post-to-lane", { id: "post-1", laneId: "lane-1" });

    expect(result.content).toContainEqual({ type: "text", text: 'Post post-1 moved to lane "Changelog".' });
  });

  test("create-lane needs the lanes capability, not the publish one", async () => {
    const captured = captureFetch({});
    const result = await callAs(["social.posts.publish"], "create-lane", { name: "Updates" });

    expect(result.isError).toBe(true);
    expect(result.content).toContainEqual({ type: "text", text: "This tool requires: social.lanes.manage." });
    expect(captured).toHaveLength(0);
  });

  test("move-post-to-lane can also take a post out of its lane", async () => {
    const captured = captureFetch({ data: { postId: "post-1", lane: null } });
    const result = await callAs(["social.posts.update"], "move-post-to-lane", { id: "post-1", laneId: null });

    expect(result.isError).toBeFalsy();
    expect(captured[0]).toMatchObject({ method: "PATCH", path: "/posts/post-1/lane", body: { laneId: null } });
  });
});
