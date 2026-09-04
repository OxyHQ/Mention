import type { CapabilityTicketClaims, CatalogTool } from "@oxyhq/contracts";
import {
  inputSatisfiesCapabilityLimits,
  readCapabilityAuthorization,
} from "@oxyhq/core/server";
import { MENTION_CAPABILITY_CATALOG, MENTION_TOOL_REGISTRY } from "./mention-catalog.js";
import { requestContext } from "./context.js";
import type { MentionCapabilityAuthority } from "./capability-authority.js";
import { logWarn } from "./logger.js";

export interface CapabilityHttpRequest {
  method: string;
  pathname: string;
  authorization?: string;
  idempotencyKey?: string;
  body: unknown;
}

export interface CapabilityHttpResponse {
  matched: boolean;
  status: number;
  body: Record<string, unknown>;
}

function capabilityTool(pathname: string): CatalogTool | undefined {
  return MENTION_CAPABILITY_CATALOG.tools.find((tool: CatalogTool) =>
    tool.exposure.includes("internal") && tool.invocation.path === pathname
  );
}

function resourceMatches(claims: CapabilityTicketClaims, tool: CatalogTool): boolean {
  const resource = claims.resource;
  return resource.appId === MENTION_CAPABILITY_CATALOG.appId
    && tool.resourceTypes.includes(resource.resourceType)
    && resource.resourceType === MENTION_CAPABILITY_CATALOG.accountResourceType
    && resource.resourceId === resource.effectiveAccountId;
}

function scopeMatches(
  claims: CapabilityTicketClaims,
  tool: CatalogTool,
  input: Readonly<Record<string, unknown>>,
): boolean {
  return claims.aud === MENTION_CAPABILITY_CATALOG.audience
    && claims.tool === tool.name
    && tool.requiredCapabilities.every((capability: string) => claims.capabilities.includes(capability))
    && resourceMatches(claims, tool)
    && inputSatisfiesCapabilityLimits(tool.name, input, claims.limits);
}

/**
 * Execute the canonical Mention tool handler over the native Oxy plane.
 * This is an ordinary HTTPS endpoint, not MCP transport: the only credential
 * passed to the domain API is the short-lived capability ticket.
 */
export async function handleMentionCapabilityRequest(
  request: CapabilityHttpRequest,
  authority: MentionCapabilityAuthority,
): Promise<CapabilityHttpResponse> {
  const tool = capabilityTool(request.pathname);
  if (!tool) return { matched: false, status: 404, body: { error: "not_found" } };
  if (request.method.toUpperCase() !== tool.invocation.method) {
    return { matched: true, status: 405, body: { error: "method_not_allowed" } };
  }

  const ticket = readCapabilityAuthorization(request.authorization);
  if (!ticket) {
    return { matched: true, status: 401, body: { error: "capability_ticket_required" } };
  }
  if (typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) {
    return { matched: true, status: 400, body: { error: "capability_input_schema_mismatch" } };
  }
  const input = request.body as Record<string, unknown>;

  let claims: CapabilityTicketClaims | null;
  try {
    claims = await authority.introspect(ticket);
  } catch {
    return { matched: true, status: 503, body: { error: "capability_authority_unavailable" } };
  }
  if (!claims) {
    return { matched: true, status: 403, body: { error: "capability_revoked_or_denied" } };
  }
  if (!scopeMatches(claims, tool, input)) {
    await authority.audit({
      ticket,
      result: { status: "denied", code: "capability_scope_mismatch" },
      rollbackSupported: tool.rollback === "supported",
    }).catch(() => undefined);
    return { matched: true, status: 403, body: { error: "capability_scope_mismatch" } };
  }

  const idempotencyKey = request.idempotencyKey?.trim();
  if (tool.idempotency === "required" && !idempotencyKey) {
    return { matched: true, status: 428, body: { error: "idempotency_key_required" } };
  }

  try {
    const result = await requestContext.run({
      userToken: ticket,
      authorizationScheme: "Capability",
      authMode: "capability",
      tokenId: claims.jti,
      clientId: claims.coordinator.credentialId,
      accountId: claims.resource.effectiveAccountId,
      scopes: new Set(claims.capabilities),
      toolName: tool.name,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    }, () => MENTION_TOOL_REGISTRY.invoke(tool.name, input));

    const failed = result.isError === true;
    await authority.audit({
      ticket,
      result: failed
        ? { status: "failed", code: "capability_execution_failed" }
        : { status: "succeeded" },
      rollbackSupported: tool.rollback === "supported",
      ...(idempotencyKey ? { idempotencyKey } : {}),
    }).catch((error) => {
      logWarn("Mention capability audit delivery failed", {
        ticketId: claims.jti,
        tool: tool.name,
        reason: error instanceof Error ? error.message : "unknown",
      });
    });
    return {
      matched: true,
      status: failed ? 502 : 200,
      body: result as Record<string, unknown>,
    };
  } catch {
    await authority.audit({
      ticket,
      result: { status: "failed", code: "capability_execution_failed" },
      rollbackSupported: tool.rollback === "supported",
      ...(idempotencyKey ? { idempotencyKey } : {}),
    }).catch(() => undefined);
    return { matched: true, status: 500, body: { error: "capability_execution_failed" } };
  }
}
