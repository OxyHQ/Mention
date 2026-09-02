import { Router, Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { findLiveBundleMember } from '../../db/mcp/mcpConnectionRepository';
import {
  listBundleMembers,
  setActiveAccount,
} from '../services/mcpBundleService';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import { stripMentionHandle } from '../../utils/resolveLocalMentionHandles';
import type {
  McpRequestContext,
  OxyAuthRequestWithMcp,
} from '../middleware/mcpAuth';
import { logger } from '../../utils/logger';
import { toMcpUserSummary, type McpUserSummary } from '../utils/mcpUserSummary';

const router = Router();

async function hydrateUserSummary(oxyUserId: string): Promise<McpUserSummary> {
  try {
    const user = await getServiceOxyClient().getUserById(oxyUserId, { cache: false });
    return toMcpUserSummary(oxyUserId, user);
  } catch {
    return toMcpUserSummary(oxyUserId);
  }
}

type LegacyBundleContext = McpRequestContext & {
  authMode: 'legacy';
  bundleId: string;
};

function requireMcpBundle(req: AuthRequest, res: Response): LegacyBundleContext | null {
  const mcp = (req as OxyAuthRequestWithMcp).mcp;
  if (mcp?.authMode !== 'legacy' || !mcp.bundleId) {
    res.status(403).json({ message: 'MCP bundle context required' });
    return null;
  }
  return mcp as LegacyBundleContext;
}

function requireSeparateCentralConnection(res: Response): Response {
  return res.status(409).json({
    code: 'separate_connection_required',
    message:
      'Oxy MCP connections are bound to one account. Authorize a separate Mention connection for another account.',
  });
}

/** GET /mcp/bundles/accounts — list linked accounts for the caller's MCP bundle. */
router.get('/accounts', async (req: AuthRequest, res: Response) => {
  try {
    const context = (req as OxyAuthRequestWithMcp).mcp;
    if (context?.authMode === 'central') {
      const summary = await hydrateUserSummary(context.activeUserId);
      return res.json({
        accounts: [{
          oxyUserId: context.activeUserId,
          handle: summary.handle,
          displayName: summary.displayName,
          isPrimary: true,
          isActive: true,
        }],
        activeUserId: context.activeUserId,
        bundleId: null,
      });
    }
    const mcp = requireMcpBundle(req, res);
    if (!mcp) return;

    const members = await listBundleMembers(mcp.bundleId);
    const summaries = await Promise.all(members.map((m) => hydrateUserSummary(m.oxyUserId)));

    const accounts = members.map((member, index) => ({
      oxyUserId: member.oxyUserId,
      handle: summaries[index]?.handle ?? '',
      displayName: summaries[index]?.displayName ?? 'Unknown user',
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
      isPrimary: mcp?.authMode === 'central' || mcp?.primaryUserId === userId,
      bundleId: mcp?.bundleId ?? null,
    });
  } catch (error) {
    logger.error('[McpBundles] me failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ message: 'Error resolving active account' });
  }
});

/** New accounts always require their own central Oxy authorization. */
router.post('/link-token', (req: AuthRequest, res: Response) => {
  if ((req as OxyAuthRequestWithMcp).mcp?.authMode === 'central') {
    return requireSeparateCentralConnection(res);
  }
  return res.status(410).json({
    code: 'legacy_account_linking_retired',
    message: 'Legacy bundle linking is retired. Reconnect each account through Oxy.',
  });
});

router.post('/link/complete', (_req: AuthRequest, res: Response) =>
  res.status(410).json({
    code: 'legacy_account_linking_retired',
    message: 'Legacy bundle linking is retired. Reconnect each account through Oxy.',
  }));

/** POST /mcp/bundles/active — switch the active account in the bundle. */
router.post('/active', async (req: AuthRequest, res: Response) => {
  try {
    if ((req as OxyAuthRequestWithMcp).mcp?.authMode === 'central') {
      return requireSeparateCentralConnection(res);
    }
    const mcp = requireMcpBundle(req, res);
    if (!mcp) return;

    const rawHandle = typeof req.body?.handle === 'string' ? req.body.handle : undefined;
    const rawUserId = typeof req.body?.oxyUserId === 'string' ? req.body.oxyUserId : undefined;

    let targetUserId = rawUserId;
    if (rawHandle) {
      const username = stripMentionHandle(rawHandle);
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

    const member = await findLiveBundleMember(mcp.bundleId, targetUserId);
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
