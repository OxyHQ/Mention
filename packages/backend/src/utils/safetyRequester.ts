import type { SafetyRequester } from '@oxy.so/contracts';
import { extractBearerToken } from '@oxy.so/mcp';
import { ApiError } from './error';
/** The verified request context shared by HTTP and socket entry points. */
export interface RequestSafetyContext {
  user?: { id: string } | null;
  accessToken?: string;
  headers?: { authorization?: string | readonly string[] };
  mcp?: { activeUserId?: string };
  capability?: { claims?: { resource?: { effectiveAccountId?: string } } };
}

/** Only original requester proofs reach central policy; an attributed ID is not authority. */
export function safetyRequesterFor(req: RequestSafetyContext): SafetyRequester {
  const token = req.accessToken || extractBearerToken(req.headers ?? {});
  if (req.mcp) {
    const connectionToken = extractBearerToken(req.headers ?? {});
    if (!connectionToken) throw new Error('Safety decisions require the live MCP connection proof');
    return { connectionToken };
  }
  // Oxy's safety contract accepts only a session bearer or an MCP connection
  // proof, and a capability ticket is neither: refuse it as the caller's
  // limitation (403), never as a server fault.
  if (req.capability)
    throw new ApiError(
      403,
      'This delegated capability cannot prove a safety requester',
      'SAFETY_REQUESTER_UNPROVABLE',
    );
  if (req.user && !token)
    throw new Error('Safety decisions require the original authenticated bearer');
  return { accessToken: token ?? null };
}
