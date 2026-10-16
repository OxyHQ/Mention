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
import { logError, logInfo, logWarn } from './logger.js';
import type { McpHttpConfig } from './config.js';
import type { CapabilityCatalogBinding } from '@oxy.so/contracts';
import { describeRegistrationFailure, registerMentionCatalog } from './catalog-registration.js';

const keyHeaderSchema = z.object({ kid: z.string().min(1).max(256) });

export function createMentionInternalMcp(config: McpHttpConfig, binding: CapabilityCatalogBinding) {
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
    binding,
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

type MentionInternalMcp = ReturnType<typeof createMentionInternalMcp>;

/** How long a failed registration waits before the next request retries it. */
const REGISTRATION_RETRY_MS = 30_000;

/**
 * `/_oxy/mcp`, bound to the catalogue registration this process obtains from
 * Oxy (`catalog-registration.ts`), never to a binding copied into config.
 *
 * Bound once and kept; `bound()` is called at startup so a failure is in the
 * log the moment the task starts, not when Alia first calls. Until it binds,
 * `bound()` answers `undefined` (the route answers 503) and a later request
 * retries — an Oxy outage at boot must not leave the receiver dead for the
 * task's whole life, nor take down the external OAuth MCP on the same server.
 */
export function createMentionInternalMcpReceiver(
  config: McpHttpConfig,
  register: () => Promise<CapabilityCatalogBinding> = () =>
    registerMentionCatalog({ oxy: oxyServiceClient(config), oxyApiUrl: config.oxyApiUrl }),
  now: () => number = Date.now,
) {
  let service: MentionInternalMcp | undefined;
  let pending: Promise<MentionInternalMcp | undefined> | undefined;
  let retryAt = 0;
  return {
    bound(): Promise<MentionInternalMcp | undefined> {
      if (service) return Promise.resolve(service);
      if (pending) return pending;
      if (now() < retryAt) return Promise.resolve(undefined);
      pending = register()
        .then((binding) => {
          // Throws when the registration is not this catalogue's: caught below.
          service = createMentionInternalMcp(config, binding);
          logInfo('Mention internal MCP bound to its catalogue registration', {
            registrationId: binding.registrationId,
            version: binding.version,
          });
          return service;
        })
        .catch((error: unknown) => {
          retryAt = now() + REGISTRATION_RETRY_MS;
          logError(
            'Mention internal MCP could not bind its catalogue registration; /_oxy/mcp answers 503 until it does',
            error,
            { reason: describeRegistrationFailure(error) },
          );
          return undefined;
        })
        .finally(() => {
          pending = undefined;
        });
      return pending;
    },
  };
}
