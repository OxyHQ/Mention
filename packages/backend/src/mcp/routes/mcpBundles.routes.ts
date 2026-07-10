import { Router, Request, Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { getNormalizedUserHandle } from '@oxyhq/core';
import { McpConnection } from '../models/McpConnection';
import {
  listBundleMembers,
  setActiveAccount,
  signLinkToken,
  verifyLinkToken,
  consumeLinkToken,
  countBundleMembers,
} from '../services/mcpBundleService';
import { generateJti, generateRefreshToken } from '../services/mcpTokenService';
import { getMcpClientAsync } from '../config/mcpClients';
import { MCP_FRONTEND_ORIGIN, MCP_LINK_PATH, MCP_MAX_BUNDLE_MEMBERS } from '../config/constants';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import type { OxyAuthRequestWithMcp } from '../middleware/mcpAuth';
import { logger } from '../../utils/logger';

const router = Router();

function stripHandle(handle: string): string {
  return handle.replace(/^@+/, '').trim();
}

async function hydrateUserSummary(oxyUserId: string): Promise<{
  oxyUserId: string;
  username: string;
  handle: string;
  displayName: string;
}> {
  try {
    const user = await getServiceOxyClient().getUserById(oxyUserId, { cache: false });
    const username = typeof user.username === 'string' ? user.username : oxyUserId;
    const handle = getNormalizedUserHandle(user) ?? username;
    const displayName = user.name?.displayName?.trim() || handle;
    return { oxyUserId, username, handle, displayName };
  } catch {
    return {
      oxyUserId,
      username: oxyUserId,
      handle: oxyUserId,
      displayName: 'Unknown user',
    };
  }
}

function requireMcpBundle(req: AuthRequest, res: Response): OxyAuthRequestWithMcp['mcp'] | null {
  const mcp = (req as OxyAuthRequestWithMcp).mcp;
  if (!mcp?.bundleId) {
    res.status(403).json({ message: 'MCP bundle context required' });
    return null;
  }
  return mcp;
}

/** GET /mcp/bundles/accounts — list linked accounts for the caller's MCP bundle. */
router.get('/accounts', async (req: AuthRequest, res: Response) => {
  try {
    const mcp = requireMcpBundle(req, res);
    if (!mcp) return;

    const members = await listBundleMembers(mcp.bundleId);
    const summaries = await Promise.all(members.map((m) => hydrateUserSummary(m.oxyUserId)));

    const accounts = members.map((member, index) => ({
      oxyUserId: member.oxyUserId,
      handle: summaries[index]?.handle ?? member.oxyUserId,
      displayName: summaries[index]?.displayName ?? member.oxyUserId,
      isPrimary: member.isBundlePrimary === true,
      isActive: member.oxyUserId === mcp.activeUserId,
    }));

    return res.json({
      accounts,
      activeUserId: mcp.activeUserId,
      bundleId: mcp.bundleId,
    });
  } catch (error) {
    logger.error('[McpBundles] list accounts failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ message: 'Error listing bundle accounts' });
  }
});

/** GET /mcp/bundles/me — active account summary (whoami). */
router.get('/me', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    const mcp = (req as OxyAuthRequestWithMcp).mcp;
    const summary = await hydrateUserSummary(userId);
    return res.json({
      ...summary,
      isPrimary: mcp?.primaryUserId === userId,
      bundleId: mcp?.bundleId ?? null,
    });
  } catch (error) {
    logger.error('[McpBundles] me failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ message: 'Error resolving active account' });
  }
});

/** POST /mcp/bundles/link-token — mint a browser link token for add-account flow. */
router.post('/link-token', async (req: AuthRequest, res: Response) => {
  try {
    const mcp = requireMcpBundle(req, res);
    if (!mcp) return;

    const token = signLinkToken(mcp.bundleId, mcp.clientId);
    const linkUrl = `${MCP_FRONTEND_ORIGIN}${MCP_LINK_PATH}?token=${encodeURIComponent(token)}`;

    return res.json({
      token,
      linkUrl,
      expiresInSeconds: 900,
    });
  } catch (error) {
    logger.error('[McpBundles] link-token failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ message: 'Error creating link token' });
  }
});

/** POST /mcp/bundles/link/complete — link the signed-in user to an MCP bundle. */
router.post('/link/complete', async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = req.user?.id;
    if (!oxyUserId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const linkToken = typeof req.body?.token === 'string' ? req.body.token : undefined;
    if (!linkToken) {
      return res.status(400).json({ message: 'token is required' });
    }
    const parsed = verifyLinkToken(linkToken);
    if (!parsed) {
      return res.status(400).json({ message: 'Invalid or expired link token' });
    }

    const consumed = await consumeLinkToken(linkToken);
    if (!consumed) {
      return res.status(400).json({ message: 'Link token already used or unavailable' });
    }

    const existing = await McpConnection.findOne({
      bundleId: parsed.bundleId,
      oxyUserId,
      revokedAt: null,
    }).lean();
    if (existing) {
      const summary = await hydrateUserSummary(oxyUserId);
      return res.json({
        message: 'Already linked',
        handle: summary.handle,
        bundleId: parsed.bundleId,
      });
    }

    const primary = await McpConnection.findOne({
      bundleId: parsed.bundleId,
      isBundlePrimary: true,
      revokedAt: null,
      clientId: parsed.clientId,
    });
    if (!primary) {
      return res.status(404).json({ message: 'Bundle not found' });
    }

    const client = await getMcpClientAsync(parsed.clientId);
    if (!client) {
      return res.status(400).json({ message: 'Unknown client' });
    }

    const memberCount = await countBundleMembers(parsed.bundleId);
    if (memberCount >= MCP_MAX_BUNDLE_MEMBERS) {
      return res.status(400).json({
        message: `This connector already has the maximum of ${MCP_MAX_BUNDLE_MEMBERS} linked accounts`,
      });
    }

    const refresh = generateRefreshToken();
    try {
      await McpConnection.create({
        oxyUserId,
        clientId: parsed.clientId,
        clientLabel: client.label,
        scopes: primary.scopes,
        bundleId: parsed.bundleId,
        isBundlePrimary: false,
        refreshTokenHash: refresh.hash,
        jti: generateJti(),
        lastUsedAt: new Date(),
      });
    } catch (createError: unknown) {
      const code = createError && typeof createError === 'object' && 'code' in createError
        ? (createError as { code?: number }).code
        : undefined;
      if (code === 11000) {
        const summary = await hydrateUserSummary(oxyUserId);
        return res.json({
          message: 'Already linked',
          handle: summary.handle,
          bundleId: parsed.bundleId,
        });
      }
      throw createError;
    }

    const summary = await hydrateUserSummary(oxyUserId);
    return res.json({
      message: 'Account linked',
      handle: summary.handle,
      displayName: summary.displayName,
      bundleId: parsed.bundleId,
    });
  } catch (error) {
    logger.error('[McpBundles] link complete failed', {
      userId: req.user?.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ message: 'Error linking account' });
  }
});

/** POST /mcp/bundles/active — switch the active account in the bundle. */
router.post('/active', async (req: AuthRequest, res: Response) => {
  try {
    const mcp = requireMcpBundle(req, res);
    if (!mcp) return;

    const rawHandle = typeof req.body?.handle === 'string' ? req.body.handle : undefined;
    const rawUserId = typeof req.body?.oxyUserId === 'string' ? req.body.oxyUserId : undefined;

    let targetUserId = rawUserId;
    if (rawHandle) {
      const username = stripHandle(rawHandle);
      try {
        const profile = await getServiceOxyClient().getProfileByUsername(username, { cache: false });
        targetUserId = profile.id;
      } catch {
        return res.status(404).json({ message: `User @${username} not found` });
      }
    }

    if (!targetUserId) {
      return res.status(400).json({ message: 'handle or oxyUserId is required' });
    }

    const member = await McpConnection.findOne({
      bundleId: mcp.bundleId,
      oxyUserId: targetUserId,
      revokedAt: null,
    }).lean();
    if (!member) {
      return res.status(404).json({ message: 'Account is not linked to this connector' });
    }

    const persisted = await setActiveAccount(mcp.bundleId, targetUserId);
    if (!persisted) {
      return res.status(503).json({ message: 'Could not persist active account switch' });
    }
    const summary = await hydrateUserSummary(targetUserId);
    return res.json({
      message: 'Active account updated',
      activeUserId: targetUserId,
      handle: summary.handle,
      displayName: summary.displayName,
    });
  } catch (error) {
    logger.error('[McpBundles] switch active failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ message: 'Error switching active account' });
  }
});

export default router;
