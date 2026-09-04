import {
  appCapabilityCatalogSchema,
  type AppCapabilityCatalog,
  type CatalogTool,
} from "@oxyhq/contracts";
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import { toJSONSchema } from "zod/v4-mini";
import {
  MENTION_CAPABILITY_AUDIENCE,
  MENTION_MCP_RESOURCE,
} from "@mention/shared-types/mcpCapabilities";
import { requestContext } from "./context.js";

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

export type MentionToolHandler<Shape extends MentionToolShape> = (
  args: z.infer<z.ZodObject<Shape>>,
) => CallToolResult | Promise<CallToolResult>;

export interface MentionToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputShape: MentionToolShape;
  readonly handler: MentionToolHandler<MentionToolShape>;
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
    handler: MentionToolHandler<Shape>,
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
    handler: MentionToolHandler<Shape>,
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
      handler: handler as MentionToolHandler<MentionToolShape>,
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
        async (args, extra) => {
          const context = requestContext.getStore();
          if (
            context?.authMode === "central" &&
            !definition.policy.requiredCapabilities.every((capability: string) =>
              context.scopes.has(capability)
            )
          ) {
            return {
              content: [{
                type: "text" as const,
                text: `This tool requires: ${definition.policy.requiredCapabilities.join(", ")}.`,
              }],
              isError: true,
            };
          }
          if (definition.policy.effect === "read" || !context) {
            return definition.handler(args);
          }

          if (
            !context.accountId ||
            !context.clientId ||
            !context.tokenId ||
            extra.requestId === undefined
          ) {
            return {
              content: [{
                type: "text" as const,
                text: "This write could not be bound to an authenticated MCP request. Start a new connection and try again.",
              }],
              isError: true,
            };
          }

          const idempotencyKey = effectIdempotencyKey({
            accountId: context.accountId,
            clientId: context.clientId,
            transportId: extra.sessionId ?? `token:${context.tokenId}`,
            requestId: extra.requestId,
            toolName: definition.name,
          });
          return requestContext.run(
            { ...context, idempotencyKey, toolName: definition.name },
            () => definition.handler(args),
          );
        },
      );
    }
  }

  async invoke(
    name: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<CallToolResult> {
    const definition = this.#definitions.find((candidate) => candidate.name === name);
    if (!definition) throw new Error(`Unknown Mention tool: ${name}`);
    const parsed = z.object(definition.inputShape).parse(input);
    return definition.handler(parsed);
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
        invocation: {
          method: "POST",
          path: `/_oxy/capabilities/${definition.name}`,
        },
      };
    });

    return appCapabilityCatalogSchema.parse({
      schemaVersion: "1",
      appId: "mention",
      version: "1.3.0",
      audience: MENTION_CAPABILITY_AUDIENCE,
      internalBaseUrl: MENTION_MCP_RESOURCE,
      externalMcp: { resource: MENTION_MCP_RESOURCE },
      accountResourceType: "mention_account",
      tools,
      events: [],
    });
  }
}

export function effectIdempotencyKey(input: {
  accountId: string;
  clientId: string;
  transportId: string;
  requestId: string | number;
  toolName: string;
}): string {
  const digest = createHash("sha256")
    .update(input.accountId)
    .update("\0")
    .update(input.clientId)
    .update("\0")
    .update(input.transportId)
    .update("\0")
    .update(typeof input.requestId)
    .update(":")
    .update(String(input.requestId))
    .update("\0")
    .update(input.toolName)
    .digest("hex");
  return `mcp:${digest}`;
}
