/** Internal pilot reuses the canonical handlers; the domain API remains authoritative. */
import { createInternalCatalogMcpHttpService, type InvocationHandlers } from '@oxy.so/mcp';
import {
  createLiveCapabilityTicketVerifier,
  createOxyJwksKeyResolver,
  readCapabilityAuthorization,
} from '@oxy.so/core/server';
import { z } from 'zod/v4';
import { MENTION_CAPABILITY_CATALOG, MENTION_TOOL_REGISTRY } from './mention-catalog.js';
import { requestContext } from './context.js';
import { oxyServiceClient } from './oxy-service-client.js';
import { createMentionCapabilityAuthority } from './capability-authority.js';
import { logWarn } from './logger.js';
import type { McpHttpConfig } from './config.js';

const keyHeaderSchema = z.object({ kid: z.string().min(1).max(256) });

export function createMentionInternalMcp(config: McpHttpConfig) {
  if (!config.internalCatalogBinding) return undefined;
  const oxy = oxyServiceClient(config);
  const audit = createMentionCapabilityAuthority(config);
  const resolveKey = createOxyJwksKeyResolver({
    jwksUrl: `${config.oxyApiUrl}/capabilities/.well-known/jwks.json`,
  });
  const verifyTicket = async (ticket: string, options: { signal: AbortSignal }) => {
    options.signal.throwIfAborted();
    if (ticket.length > 32768) throw new Error('Capability ticket exceeds size bound');
    const kid = keyHeaderSchema.parse(
      JSON.parse(Buffer.from(ticket.split('.')[0] ?? '', 'base64url').toString()),
    ).kid;
    // Untrusted kid selects a trusted JWKS key only; the common verifier checks
    // the original signed bytes, issuer, audience, TTL and live claims next.
    const key = await resolveKey(kid);
    const verify = createLiveCapabilityTicketVerifier({
      issuer: config.oxyApiUrl,
      audience: MENTION_CAPABILITY_CATALOG.audience,
      resolvePublicKey: (requested) => (requested === kid ? key : undefined),
      introspect: async (token, request) => {
        const result = await oxy.agency.introspectCapabilityTicket(token, request);
        return result.decision?.allowed === true ? result : { ...result, active: false };
      },
    });
    return verify(ticket, options);
  };
  const handlers: InvocationHandlers = Object.fromEntries(
    MENTION_CAPABILITY_CATALOG.tools
      .filter((tool) => tool.exposure.includes('internal'))
      .map((tool) => [
        tool.name,
        async (input, context) => {
          if (context.principal.kind !== 'capability')
            throw new Error('Capability principal required');
          const headers = context.request.requestInfo?.headers;
          const authorization = headers?.authorization;
          const ticket = readCapabilityAuthorization(
            typeof authorization === 'string' ? authorization : undefined,
          );
          if (!ticket) throw new Error('Verified transport ticket missing');
          const key = headers?.['idempotency-key'];
          const idempotencyKey = typeof key === 'string' ? key.trim() : undefined;
          const claims = context.principal.claims;
          const result = await requestContext.run(
            {
              userToken: ticket,
              authorizationScheme: 'Capability',
              authMode: 'capability',
              tokenId: claims.jti,
              clientId: claims.coordinator.credentialId,
              accountId: claims.resource.effectiveAccountId,
              scopes: new Set(claims.capabilities),
              toolName: tool.name,
              ...(idempotencyKey ? { idempotencyKey } : {}),
            },
            () => MENTION_TOOL_REGISTRY.invoke(tool.name, input),
          );
          // Audit delivery never turns an already committed domain effect into a
          // transport failure; the domain's durable idempotency receipt survives.
          await audit
            .audit({
              ticket,
              result: result.isError
                ? { status: 'failed', code: 'capability_execution_failed' }
                : { status: 'succeeded' },
              rollbackSupported: tool.rollback === 'supported',
              ...(idempotencyKey ? { idempotencyKey } : {}),
            })
            .catch((error) =>
              logWarn('Mention internal MCP audit delivery failed', {
                tool: tool.name,
                reason: error instanceof Error ? error.name : 'unknown',
              }),
            );
          if (tool.effect === 'read') {
            await verifyTicket(ticket, { signal: context.request.signal });
          }
          return result;
        },
      ]),
  );
  return createInternalCatalogMcpHttpService({
    catalog: MENTION_CAPABILITY_CATALOG,
    binding: config.internalCatalogBinding,
    handlers,
    verifyTicket,
    allowedOrigins: [...config.allowedOrigins],
    maxBodyBytes: config.maxRequestBodyBytes,
    resolveResource: (_input, context) => context.principal.claims.resource,
    authorize: async (_input, context) => {
      if (context.principal.kind !== 'capability')
        return { allowed: false, reason: 'capability_required' };
      const resource = context.principal.claims.resource;
      // Input cannot pick an account. Each canonical handler forwards the exact
      // ticket to Mention's backend, which independently rechecks signature,
      // live authority, route/tool/limits and product permissions before effects.
      return resource.resourceType === MENTION_CAPABILITY_CATALOG.accountResourceType &&
        resource.resourceId === resource.effectiveAccountId
        ? { allowed: true, effectiveAccountId: resource.effectiveAccountId }
        : { allowed: false, reason: 'account_resource_mismatch' };
    },
  });
}
