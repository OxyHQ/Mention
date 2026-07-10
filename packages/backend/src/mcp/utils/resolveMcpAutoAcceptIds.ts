import type { Request } from 'express';
import type { OxyAuthRequestWithMcp } from '../middleware/mcpAuth';
import { intersectWithBundleMembers } from '../services/mcpBundleService';

/** Intersection of invited collaborator ids with non-revoked MCP bundle members. */
export async function resolveMcpAutoAcceptIds(
  req: Request,
  invitedIds: string[] | undefined,
): Promise<string[] | undefined> {
  if (!invitedIds || invitedIds.length === 0) return undefined;
  const mcp = (req as OxyAuthRequestWithMcp).mcp;
  if (!mcp?.bundleId) return undefined;
  const intersection = await intersectWithBundleMembers(mcp.bundleId, invitedIds);
  return intersection.length > 0 ? intersection : undefined;
}
