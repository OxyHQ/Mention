import { Router, Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { McpConnection } from '../models/McpConnection';
import { revokeJti } from '../services/mcpRevocationService';
import { logger } from '../../utils/logger';

/**
 * Connection-management API for the signed-in user: list the MCP clients they
 * have authorized and revoke any of them. Mounted on the authenticated router,
 * so the caller's identity (`req.user.id`) is always the resource owner — every
 * query is scoped to `oxyUserId` and a connection is never addressable across
 * users.
 */

const router = Router();

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

    // Never leak secret material (refreshTokenHash / jti) to the client.
    const sanitized = connections.map((c) => ({
      id: String(c._id),
      clientId: c.clientId,
      clientLabel: c.clientLabel,
      scopes: c.scopes,
      createdAt: c.createdAt,
      lastUsedAt: c.lastUsedAt,
    }));

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
