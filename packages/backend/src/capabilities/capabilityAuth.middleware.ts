import type { CapabilityTicketClaims } from '@oxyhq/contracts';
import {
  CapabilityTicketError,
  inputSatisfiesCapabilityLimits,
  readCapabilityAuthorization,
} from '@oxyhq/core/server';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  MENTION_TOOL_POLICIES,
  mentionCapabilityRequirementsForRequest,
} from '@mention/shared-types/mcpCapabilities';
import {
  introspectMentionCapabilityTicket,
  verifyMentionCapabilityTicket,
} from './capabilityAuthority.service';
import { logger } from '../utils/logger';

export interface MentionCapabilityContext {
  ticket: string;
  claims: CapabilityTicketClaims;
}

export type RequestWithMentionCapability = Request & {
  capability?: MentionCapabilityContext;
  user?: { id?: string };
  userId?: string;
  accessToken?: string;
};

export interface MentionCapabilityAuthDependencies {
  verify(ticket: string): Promise<CapabilityTicketClaims>;
  introspect(ticket: string, claims: CapabilityTicketClaims): Promise<boolean>;
}

const defaultDependencies: MentionCapabilityAuthDependencies = {
  verify: verifyMentionCapabilityTicket,
  introspect: introspectMentionCapabilityTicket,
};

type MentionLimitKey = {
  key: string;
  kind: 'maximum_number' | 'exact_boolean';
};
const SERIALIZED_NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function requestInput(
  request: Request,
  limitKeys: readonly MentionLimitKey[],
): Record<string, unknown> {
  const body = typeof request.body === 'object' && request.body !== null && !Array.isArray(request.body)
    ? request.body as Record<string, unknown>
    : {};
  const input: Record<string, unknown> = { ...request.query, ...body };
  for (const limitKey of limitKeys) {
    normalizeLimitValueAtPath(input, limitKey.key.split('.'), limitKey.kind);
  }
  return input;
}

function normalizeLimitValueAtPath(
  input: Record<string, unknown>,
  path: readonly string[],
  kind: MentionLimitKey['kind'],
): void {
  const [segment, ...rest] = path;
  if (!segment || !Object.prototype.hasOwnProperty.call(input, segment)) return;
  if (rest.length > 0) {
    const nested = input[segment];
    if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
      normalizeLimitValueAtPath(nested as Record<string, unknown>, rest, kind);
    }
    return;
  }
  input[segment] = normalizeLimitValue(input[segment], kind);
}

function normalizeLimitValue(value: unknown, kind: MentionLimitKey['kind']): unknown {
  if (Array.isArray(value)) return value.map((entry) => normalizeLimitValue(entry, kind));
  if (typeof value !== 'string') return value;
  if (kind === 'maximum_number' && SERIALIZED_NUMBER_PATTERN.test(value)) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : value;
  }
  if (kind === 'exact_boolean' && (value === 'true' || value === 'false')) {
    return value === 'true';
  }
  return value;
}

function accountResourceMatches(
  claims: CapabilityTicketClaims,
  resourceTypes: readonly string[],
): boolean {
  return claims.resource.appId === 'mention'
    && claims.resource.resourceType === 'mention_account'
    && claims.resource.resourceId === claims.resource.effectiveAccountId
    && resourceTypes.includes(claims.resource.resourceType);
}

/**
 * Authenticate the native Oxy capability scheme before either Mention's public
 * or authenticated domain routers run. A present but invalid ticket never
 * degrades to anonymous access.
 */
export function createOptionalMentionCapabilityAuth(
  dependencies: MentionCapabilityAuthDependencies = defaultDependencies,
): RequestHandler {
  return async (request: Request, response: Response, next: NextFunction) => {
    const authorization = request.header('authorization');
    if (!authorization?.toLowerCase().startsWith('capability ')) return next();
    const ticket = readCapabilityAuthorization(authorization);
    if (!ticket) {
      response.status(401).json({ error: 'invalid_capability_ticket' });
      return;
    }

    let claims: CapabilityTicketClaims;
    try {
      claims = await dependencies.verify(ticket);
    } catch (error) {
      const unavailable = !(error instanceof CapabilityTicketError);
      if (unavailable) {
        logger.warn('[CapabilityAuth] Ticket verification unavailable', {
          reason: error instanceof Error ? error.message : 'unknown',
        });
      }
      response.status(unavailable ? 503 : 401).json({
        error: unavailable ? 'capability_authority_unavailable' : 'invalid_capability_ticket',
      });
      return;
    }

    const toolName = request.header('X-Oxy-Capability-Tool')?.trim();
    const policy = toolName ? MENTION_TOOL_POLICIES[toolName] : undefined;
    const routeRequirements = mentionCapabilityRequirementsForRequest(request.method, request.path);
    const scopeMatches = policy !== undefined
      && toolName !== undefined
      && claims.tool === toolName
      && routeRequirements.some((requirement) => requirement.toolName === toolName)
      && policy.requiredCapabilities.every((capability: string) => claims.capabilities.includes(capability))
      && accountResourceMatches(claims, policy.resourceTypes)
      && inputSatisfiesCapabilityLimits(toolName, requestInput(request, policy.limitKeys), claims.limits);
    if (!scopeMatches) {
      response.status(403).json({ error: 'capability_scope_mismatch' });
      return;
    }

    try {
      if (!await dependencies.introspect(ticket, claims)) {
        response.status(403).json({ error: 'capability_revoked_or_denied' });
        return;
      }
    } catch (error) {
      logger.warn('[CapabilityAuth] Live reauthorization unavailable', {
        ticketId: claims.jti,
        reason: error instanceof Error ? error.message : 'unknown',
      });
      response.status(503).json({ error: 'capability_authority_unavailable' });
      return;
    }

    const scopedRequest = request as RequestWithMentionCapability;
    scopedRequest.user = { id: claims.resource.effectiveAccountId };
    scopedRequest.userId = claims.resource.effectiveAccountId;
    scopedRequest.accessToken = undefined;
    scopedRequest.capability = { ticket, claims };
    next();
  };
}
