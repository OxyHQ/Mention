import { describe, expect, test } from "bun:test";
import { appCapabilityCatalogSchema } from "@oxyhq/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../lib/create-server.js";
import {
  MENTION_CAPABILITY_CATALOG,
  MENTION_TOOL_REGISTRY,
} from "../lib/mention-catalog.js";

describe("Mention canonical capability catalog", () => {
  test("is valid, complete and has one policy for every tool", () => {
    expect(appCapabilityCatalogSchema.parse(MENTION_CAPABILITY_CATALOG))
      .toEqual(MENTION_CAPABILITY_CATALOG);
    expect(MENTION_CAPABILITY_CATALOG.tools).toHaveLength(59);
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
        expect(mcpTool?._meta).toMatchObject({
          "oxy/appId": "mention",
          "oxy/toolVersion": catalogTool.version,
          "oxy/requiredCapabilities": catalogTool.requiredCapabilities,
          "oxy/resourceTypes": catalogTool.resourceTypes,
        });
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
