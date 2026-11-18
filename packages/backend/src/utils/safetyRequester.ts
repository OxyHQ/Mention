import type { AccountActorChain, SafetyRequester } from '@oxy.so/contracts';
import type { ActingFor } from '@oxy.so/core/server';
import { extractBearerToken } from '@oxy.so/mcp';
import { ApiError } from './error';
/** The verified request context shared by HTTP and socket entry points. */
export interface RequestSafetyContext {
  user?: { id: string } | null;
  accessToken?: string;
  oxyActor?: AccountActorChain | null;
  serviceApp?: { authority?: 'first_party' | 'external' };
  serviceActingAs?: {
    authority?: 'first_party' | 'external';
    userId: string;
    /** The person, when they operate `userId` rather than own it (ADR 0066). */
    requesterId?: string;
  };
  headers?: { authorization?: string | readonly string[] };
  mcp?: { activeUserId?: string };
  capability?: {
    ticket?: string;
    claims?: { requesterAccountId?: string; resource?: { effectiveAccountId?: string } };
  };
}

function actingFor(accountId: string, requesterAccountId: string | undefined): ActingFor {
  return requesterAccountId && requesterAccountId !== accountId
    ? { accountId, requesterAccountId }
    : { accountId };
}

/**
 * The account another Oxy service acts for on this request, as the shared
 * middleware verified it with Oxy (`authority: first_party`, ADR 0066).
 */
export function verifiedServiceActingFor(req: RequestSafetyContext): ActingFor {
  const actingAs = req.serviceActingAs;
  if (
    req.serviceApp?.authority !== 'first_party' ||
    actingAs?.authority !== 'first_party' ||
    !req.user?.id ||
    actingAs.userId !== req.user.id
  ) {
    throw new ApiError(
      403,
      'A verified first-party service account is required',
      'SAFETY_REQUESTER_UNPROVABLE',
    );
  }
  return actingFor(actingAs.userId, actingAs.requesterId);
}

/**
 * The account Mention acts for on its own declared authority (ADR 0066) when
 * the request is not a person's session: a verified capability ticket's
 * account, or the account another Oxy service acts for. `undefined` otherwise.
 */
export function declaredActingFor(req: RequestSafetyContext): ActingFor | undefined {
  if (req.capability) {
    const accountId = req.capability.claims?.resource?.effectiveAccountId;
    if (!req.capability.ticket || !accountId)
      throw new ApiError(403, 'Capability account is missing', 'SAFETY_REQUESTER_UNPROVABLE');
    return actingFor(accountId, req.capability.claims?.requesterAccountId);
  }
  if (req.serviceApp) return verifiedServiceActingFor(req);
  return undefined;
}

/** A person's own session: the account they are in, and themselves when they operate it. */
export function personActingFor(req: RequestSafetyContext, accountId: string): ActingFor {
  const actor = req.oxyActor;
  return actingFor(
    accountId,
    actor?.effectiveAccountId === accountId ? actor.actorAccountId : undefined,
  );
}

/**
 * Who a Safety decision is for: the person's own verified bearer, the live MCP
 * connection, or the account Mention acts for on its declared `oxy:safety`.
 */
export function safetyRequesterFor(req: RequestSafetyContext): SafetyRequester {
  // Only the bearer the auth middleware VERIFIED: a raw `Authorization` header
  // the optional mount refused is not a person's proof.
  const token = req.accessToken;
  if (req.mcp) {
    const connectionToken = extractBearerToken(req.headers ?? {});
    if (!connectionToken) throw new Error('Safety decisions require the live MCP connection proof');
    return { connectionToken };
  }
  const declared = declaredActingFor(req);
  if (declared) return { actingForAccountId: declared.accountId };
  if (req.user && !token)
    throw new Error('Safety decisions require the original authenticated bearer');
  return { accessToken: token ?? null };
}
