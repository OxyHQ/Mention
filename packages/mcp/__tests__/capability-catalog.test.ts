import { describe, expect, test } from "bun:test";
import { appCapabilityCatalogSchema } from "@oxyhq/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../lib/create-server.js";
import {
  MENTION_CAPABILITY_CATALOG,
  MENTION_TOOL_REGISTRY,
} from "../lib/mention-catalog.js";
import { requestContext } from "../lib/context.js";
import { effectIdempotencyKey } from "../lib/tool-registry.js";

describe("Mention canonical capability catalog", () => {
  test("is valid, complete and has one policy for every tool", () => {
    expect(appCapabilityCatalogSchema.parse(MENTION_CAPABILITY_CATALOG))
      .toEqual(MENTION_CAPABILITY_CATALOG);
    expect(MENTION_CAPABILITY_CATALOG.tools).toHaveLength(59);
    expect(MENTION_CAPABILITY_CATALOG.externalMcp).toEqual({
      resource: "https://mcp.mention.earth",
    });
    expect(MENTION_TOOL_REGISTRY.definitions()).toHaveLength(59);
    expect(new Set(MENTION_CAPABILITY_CATALOG.tools.map((tool) => tool.name)).size).toBe(59);
  });

  test("drives MCP names, descriptions, input schemas and policy metadata", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "mention-catalog-test", version: "1.0.0" });
    const server = createMcpServer();

    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    try {
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(MENTION_CAPABILITY_CATALOG.tools.length);

      for (const catalogTool of MENTION_CAPABILITY_CATALOG.tools) {
        const mcpTool = listed.tools.find((tool) => tool.name === catalogTool.name);
        expect(mcpTool).toBeDefined();
        expect(mcpTool?.description).toBe(catalogTool.description);
        expect(mcpTool?.inputSchema).toEqual(catalogTool.inputSchema);
        expect(mcpTool?.annotations).toMatchObject({
          readOnlyHint: catalogTool.effect === "read",
          destructiveHint:
            catalogTool.effect !== "read" && catalogTool.rollback === "none",
          idempotentHint: catalogTool.idempotency !== "none",
        });
        expect(mcpTool?._meta).toMatchObject({
          "oxy/appId": "mention",
          "oxy/toolVersion": catalogTool.version,
          "oxy/requiredCapabilities": catalogTool.requiredCapabilities,
          "oxy/resourceTypes": catalogTool.resourceTypes,
        });
      }

      expect(
        MENTION_CAPABILITY_CATALOG.tools.find((tool) => tool.name === "create-post")
          ?.idempotency,
      ).toBe("supported");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("derives stable, account-bound effect keys from the JSON-RPC invocation", () => {
    const invocation = {
      accountId: "account-1",
      clientId: "client-1",
      transportId: "session-1",
      requestId: 42,
      toolName: "create-post",
    } as const;
    const first = effectIdempotencyKey(invocation);

    expect(first).toMatch(/^mcp:[a-f0-9]{64}$/);
    expect(effectIdempotencyKey(invocation)).toBe(first);
    expect(effectIdempotencyKey({ ...invocation, accountId: "account-2" })).not.toBe(first);
    expect(effectIdempotencyKey({ ...invocation, requestId: "42" })).not.toBe(first);
  });

  test("enforces each tool's semantic capability before invoking its handler", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "mention-capability-test", version: "1.0.0" });
    const server = createMcpServer();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const result = await requestContext.run({
        userToken: "central-token",
        authMode: "central",
        accountId: "account-1",
        scopes: new Set(["social.notifications.read"]),
      }, () => client.callTool({ name: "get-post", arguments: { id: "post-1" } }));
      expect(result.isError).toBe(true);
      expect(result.content).toContainEqual({
        type: "text",
        text: "This tool requires: social.posts.read.",
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
