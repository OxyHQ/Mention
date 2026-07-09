import { Router, Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { getNormalizedUserHandle } from '@oxyhq/core';
import { McpConnection } from '../models/McpConnection';
import { revokeJti } from '../services/mcpRevocationService';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import { logger } from '../../utils/logger';

/**
 * Connection-management API for the signed-in user: list the MCP clients they
 * have authorized and revoke any of them. Mounted on the authenticated router,
 * so the caller's identity (`req.user.id`) is always the resource owner — every
 * query is scoped to `oxyUserId` and a connection is never addressable across
 * users.
 */

const router = Router();

async function hydrateHandles(
  oxyUserIds: string[],
): Promise<Map<string, { handle: string; displayName: string }>> {
  const unique = Array.from(new Set(oxyUserIds));
  const map = new Map<string, { handle: string; displayName: string }>();
  if (unique.length === 0) return map;

  try {
    const users = await getServiceOxyClient().getUsersByIds(unique);
    for (const user of users) {
      const id = user.id;
      if (!id) continue;
      const handle = getNormalizedUserHandle(user) ?? user.username ?? id;
      const displayName = user.name?.displayName?.trim() || handle;
      map.set(id, { handle, displayName });
    }
  } catch (error) {
    logger.warn('[McpConnections] Failed to hydrate user handles', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  for (const id of unique) {
    if (!map.has(id)) {
      map.set(id, { handle: id, displayName: 'Unknown user' });
    }
  }
  return map;
}

/** GET /mcp/connections — list the caller's active (non-revoked) connections. */
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = req.user?.id;
    if (!oxyUserId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const connections = await McpConnection.find({ oxyUserId, revokedAt: null })
      .sort({ createdAt: -1 })
      .lean();

    const bundleIds = Array.from(
      new Set(connections.map((c) => c.bundleId).filter((id): id is string => Boolean(id))),
    );
    const bundleMembers = bundleIds.length
      ? await McpConnection.find({ bundleId: { $in: bundleIds }, revokedAt: null }).lean()
      : [];

    const allUserIds = bundleMembers.map((m) => m.oxyUserId);
    const handleMap = await hydrateHandles(allUserIds);

    const bundleHandles = new Map<string, string[]>();
    for (const member of bundleMembers) {
      if (!member.bundleId) continue;
      const entry = handleMap.get(member.oxyUserId);
      const handle = entry?.handle ?? member.oxyUserId;
      const list = bundleHandles.get(member.bundleId) ?? [];
      if (!list.includes(handle)) {
        list.push(handle);
      }
      bundleHandles.set(member.bundleId, list);
    }

    // Never leak secret material (refreshTokenHash / jti) to the client.
    const sanitized = connections.map((c) => {
      const profile = handleMap.get(c.oxyUserId);
      const handlesInBundle = c.bundleId ? bundleHandles.get(c.bundleId) ?? [] : [];
      return {
        id: String(c._id),
        clientId: c.clientId,
        clientLabel: c.clientLabel,
        scopes: c.scopes,
        bundleId: c.bundleId ?? null,
        isBundlePrimary: c.isBundlePrimary === true,
        handle: profile?.handle ?? c.oxyUserId,
        displayName: profile?.displayName ?? c.oxyUserId,
        bundleHandles: handlesInBundle,
        createdAt: c.createdAt,
        lastUsedAt: c.lastUsedAt,
      };
    });

    return res.json({ connections: sanitized, count: sanitized.length });
  } catch (error) {
    logger.error('[McpConnections] list failed', {
      userId: req.user?.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ message: 'Error fetching connections' });
  }
});

/** DELETE /mcp/connections/:id — revoke a connection and blocklist its token family. */
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = req.user?.id;
    if (!oxyUserId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    const { id } = req.params;

    // Ownership-scoped update: a user can only revoke their OWN connection.
    const connection = await McpConnection.findOneAndUpdate(
      { _id: id, oxyUserId, revokedAt: null },
      { revokedAt: new Date() },
      { new: true },
    );

    if (!connection) {
      return res.status(404).json({ message: 'Connection not found' });
    }

    // Immediately invalidate any outstanding access token for this family.
    await revokeJti(connection.jti);

    return res.json({ message: 'Connection revoked' });
  } catch (error) {
    logger.error('[McpConnections] revoke failed', {
      userId: req.user?.id,
      connectionId: req.params.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ message: 'Error revoking connection' });
  }
});

export default router;
