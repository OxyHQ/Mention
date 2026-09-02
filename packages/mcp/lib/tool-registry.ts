import {
  appCapabilityCatalogSchema,
  type AppCapabilityCatalog,
  type CatalogTool,
} from "@oxyhq/contracts";
import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { toJSONSchema } from "zod/v4-mini";

export type MentionToolPolicy = Pick<
  CatalogTool,
  | "capabilityPackage"
  | "requiredCapabilities"
  | "resourceTypes"
  | "effect"
  | "idempotency"
  | "rollback"
  | "exposure"
  | "limitKeys"
  | "invocation"
>;

// The MCP SDK models raw shapes as mutable records. Zod 4.5 made its public
// ZodRawShape alias readonly, while every concrete tool shape here is a normal
// mutable object literal.
export type MentionToolShape = Record<string, z.ZodType>;

export interface MentionToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputShape: MentionToolShape;
  readonly handler: ToolCallback<MentionToolShape>;
  readonly policy: MentionToolPolicy;
}

/**
 * The deliberately small registration surface consumed by Mention's tool
 * modules. A tool is declared once; this registry compiles that declaration to
 * both MCP registration and the Oxy capability catalog.
 */
export interface MentionToolRegistrar {
  tool<Shape extends MentionToolShape>(
    name: string,
    description: string,
    inputShape: Shape,
    handler: ToolCallback<Shape>,
  ): void;
}

export class MentionToolRegistry implements MentionToolRegistrar {
  readonly #definitions: MentionToolDefinition[] = [];
  readonly #names = new Set<string>();

  constructor(private readonly policies: Readonly<Record<string, MentionToolPolicy>>) {}

  tool<Shape extends MentionToolShape>(
    name: string,
    description: string,
    inputShape: Shape,
    handler: ToolCallback<Shape>,
  ): void {
    if (this.#names.has(name)) {
      throw new Error(`Duplicate Mention tool definition: ${name}`);
    }
    const policy = this.policies[name];
    if (!policy) {
      throw new Error(`Missing Mention capability policy for tool: ${name}`);
    }

    this.#names.add(name);
    this.#definitions.push(Object.freeze({
      name,
      description,
      inputShape,
      handler: handler as ToolCallback<MentionToolShape>,
      policy,
    }));
  }

  definitions(): readonly MentionToolDefinition[] {
    return this.#definitions;
  }

  assertComplete(): void {
    const unusedPolicies = Object.keys(this.policies).filter((name) => !this.#names.has(name));
    if (unusedPolicies.length > 0) {
      throw new Error(`Capability policies without Mention tools: ${unusedPolicies.join(", ")}`);
    }
  }

  registerWithMcp(server: McpServer): void {
    for (const definition of this.#definitions) {
      server.registerTool(
        definition.name,
        {
          description: definition.description,
          inputSchema: definition.inputShape,
          annotations: {
            readOnlyHint: definition.policy.effect === "read",
            destructiveHint:
              definition.policy.effect !== "read" && definition.policy.rollback === "none",
            idempotentHint: definition.policy.idempotency !== "none",
          },
          _meta: {
            "oxy/appId": "mention",
            "oxy/toolVersion": "1.0.0",
            "oxy/requiredCapabilities": definition.policy.requiredCapabilities,
            "oxy/resourceTypes": definition.policy.resourceTypes,
          },
        },
        definition.handler,
      );
    }
  }

  capabilityCatalog(): AppCapabilityCatalog {
    const tools: CatalogTool[] = this.#definitions.map((definition) => {
      const { "~standard": _standard, ...inputSchema } = toJSONSchema(
        z.object(definition.inputShape),
        {
          target: "draft-7",
          io: "input",
        },
      );
      return {
        name: definition.name,
        version: "1.0.0",
        description: definition.description,
        inputSchema,
        ...definition.policy,
      };
    });

    return appCapabilityCatalogSchema.parse({
      schemaVersion: "1",
      appId: "mention",
      version: "1.0.0",
      audience: "mention-api",
      internalBaseUrl: "https://api.mention.earth",
      accountResourceType: "mention_account",
      tools,
      events: [],
    });
  }
}
