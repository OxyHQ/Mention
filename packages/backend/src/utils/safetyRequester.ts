import type { AccountActorChain, SafetyRequester } from '@oxy.so/contracts';
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
    requesterContext?: string;
  };
  headers?: { authorization?: string | readonly string[] };
  mcp?: { activeUserId?: string };
  capability?: { ticket?: string; claims?: { resource?: { effectiveAccountId?: string } } };
}

/** This field is populated only by shared middleware after central live verification. */
export function verifiedDownstreamRequester(req: RequestSafetyContext): string {
  const actingAs = req.serviceActingAs;
  if (
    req.serviceApp?.authority !== 'first_party' ||
    actingAs?.authority !== 'first_party' ||
    !actingAs.requesterContext ||
    !req.user?.id ||
    actingAs.userId !== req.user.id
  ) {
    throw new ApiError(
      403,
      'Verified downstream requester proof is required',
      'SAFETY_REQUESTER_UNPROVABLE',
    );
  }
  return actingAs.requesterContext;
}

/** Only original requester proofs reach central policy; an attributed ID is not authority. */
export function safetyRequesterFor(req: RequestSafetyContext): SafetyRequester {
  const token = req.accessToken || extractBearerToken(req.headers ?? {});
  if (req.mcp) {
    const connectionToken = extractBearerToken(req.headers ?? {});
    if (!connectionToken) throw new Error('Safety decisions require the live MCP connection proof');
    return { connectionToken };
  }
  if (req.capability) {
    if (!req.capability.ticket)
      throw new ApiError(403, 'Capability proof is missing', 'SAFETY_REQUESTER_UNPROVABLE');
    return { capabilityTicket: req.capability.ticket };
  }
  if (req.serviceApp) return { requesterContext: verifiedDownstreamRequester(req) };
  if (req.user && !token)
    throw new Error('Safety decisions require the original authenticated bearer');
  return { accessToken: token ?? null };
}
