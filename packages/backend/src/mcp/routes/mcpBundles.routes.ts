import { Router, Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxy.so/core/server';
import { extractBearerToken } from '@oxy.so/mcp';
import {
  requestAccountLink,
  selectConnectionAccount,
} from '../services/mcpConnectionDirectory';
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
    const user = await getServiceOxyClient().users.get(oxyUserId, { cache: false });
    return toMcpUserSummary(oxyUserId, user);
  } catch {
    return toMcpUserSummary(oxyUserId);
  }
}

/** The request's MCP connection, or a 403 for a caller that is not one. */
function requireMcpConnection(req: AuthRequest, res: Response): McpRequestContext | null {
  const mcp = (req as OxyAuthRequestWithMcp).mcp;
  if (!mcp) {
    res.status(403).json({ message: 'MCP connection required' });
    return null;
  }
  return mcp;
}

/**
 * The live MCP bearer for this request.
 *
 * The connection routes hand it to Oxy as the SUBJECT of a service-authenticated
 * call — "which connection is this token driving" — which is why the token is
 * read straight off the header instead of from `req.accessToken`, where MCP
 * requests deliberately leave it unset.
 */
function centralAccessToken(req: AuthRequest, res: Response): string | null {
  const token = extractBearerToken(
    (req as unknown as { headers: Record<string, unknown> }).headers,
  );
  if (!token) {
    res.status(401).json({ message: 'MCP access token required' });
    return null;
  }
  return token;
}

/**
 * Status and message off a failed Oxy service call.
 *
 * The SDK normalizes an OAuth-shaped refusal into `{ status, code, message }`
 * with `error_description` as the message, so Oxy's own reason for refusing —
 * "that account is not connected to this MCP connection" — reaches the caller
 * instead of a generic 502. Anything that is not a client-side refusal is one:
 * an Oxy outage is not the caller's mistake.
 */
function oxyFailure(error: unknown): { status: number; message: string; code?: string } {
  const failure = error as { status?: number; message?: string; code?: string } | undefined;
  const clientRefusal = typeof failure?.status === 'number'
    && failure.status >= 400 && failure.status < 500;
  return {
    status: clientRefusal ? failure.status as number : 502,
    message: clientRefusal && typeof failure?.message === 'string' && failure.message.length > 0
      ? failure.message
      : 'Oxy could not complete this connection request',
    ...(typeof failure?.code === 'string' ? { code: failure.code } : {}),
  };
}

/** GET /mcp/bundles/accounts — the accounts the caller's MCP connection may act as. */
router.get('/accounts', async (req: AuthRequest, res: Response) => {
  try {
    const context = requireMcpConnection(req, res);
    if (!context) return;
    // Oxy owns the account set; Mention only adds the Mention-side identity.
    const members = context.connection?.accounts
      ?? [{ accountId: context.activeUserId, isOrigin: true, linkedAt: '' }];
    const summaries = await Promise.all(
      members.map((member) => hydrateUserSummary(member.accountId)),
    );
    return res.json({
      accounts: members.map((member, index) => ({
        oxyUserId: member.accountId,
        handle: summaries[index]?.handle ?? '',
        displayName: summaries[index]?.displayName ?? 'Unknown user',
        isPrimary: member.isOrigin,
        isActive: member.accountId === context.activeUserId,
      })),
      activeUserId: context.activeUserId,
      connectionId: context.connection?.connectionId ?? null,
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
    // "Primary" is the account the connector was authorized for. On a
    // connection that has since been widened, a linked account is NOT it.
    const isPrimary = mcp?.connection ? mcp.connection.originAccountId === userId : true;
    return res.json({
      ...summary,
      isPrimary,
    });
  } catch (error) {
    logger.error('[McpBundles] me failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ message: 'Error resolving active account' });
  }
});

/**
 * POST /mcp/bundles/link-token — a URL for connecting ANOTHER account.
 *
 * Oxy mints it, Oxy consumes it, and the account that joins is whoever approves
 * it there. Mention only carries the request, because nothing about which
 * accounts a connector may act as belongs in a Mention table.
 */
router.post('/link-token', async (req: AuthRequest, res: Response) => {
  if (!requireMcpConnection(req, res)) return;
  const token = centralAccessToken(req, res);
  if (!token) return;
  try {
    const link = await requestAccountLink(token);
    return res.json({
      linkUrl: link.linkUrl,
      expiresInSeconds: link.expiresInSeconds,
      connectionId: link.connectionId,
    });
  } catch (error) {
    const failure = oxyFailure(error);
    logger.warn('[McpBundles] account link request failed', {
      status: failure.status,
      code: failure.code,
    });
    return res.status(failure.status).json({ message: failure.message });
  }
});

/**
 * Resolve the account a switch request names, by handle or by Oxy id.
 *
 * Returns null once it has answered the request itself (unknown handle, or
 * neither field given).
 */
async function resolveSwitchTarget(req: AuthRequest, res: Response): Promise<string | null> {
  const rawHandle = typeof req.body?.handle === 'string' ? req.body.handle : undefined;
  const rawUserId = typeof req.body?.oxyUserId === 'string' ? req.body.oxyUserId : undefined;

  if (rawHandle) {
    const username = stripMentionHandle(rawHandle);
    try {
      const profile = await getServiceOxyClient().users.byUsername(username, { cache: false });
      return profile.id;
    } catch {
      res.status(404).json({ message: `User @${username} not found` });
      return null;
    }
  }
  if (!rawUserId) {
    res.status(400).json({ message: 'handle or oxyUserId is required' });
    return null;
  }
  return rawUserId;
}

/** POST /mcp/bundles/active — act as another account on this connection. */
router.post('/active', async (req: AuthRequest, res: Response) => {
  try {
    if (!requireMcpConnection(req, res)) return;
    const token = centralAccessToken(req, res);
    if (!token) return;
    const targetUserId = await resolveSwitchTarget(req, res);
    if (!targetUserId) return;
    try {
      // Oxy is the authority on membership: it refuses an account that never
      // approved this connection, or whose approval no longer holds.
      const connection = await selectConnectionAccount(token, targetUserId);
      const summary = await hydrateUserSummary(connection.activeAccountId);
      return res.json({
        message: 'Active account updated',
        activeUserId: connection.activeAccountId,
        handle: summary.handle,
        displayName: summary.displayName,
      });
    } catch (error) {
      const failure = oxyFailure(error);
      logger.warn('[McpBundles] account switch failed', {
        status: failure.status,
        code: failure.code,
      });
      return res.status(failure.status).json({ message: failure.message });
    }
  } catch (error) {
    logger.error('[McpBundles] switch active failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ message: 'Error switching active account' });
  }
});

export default router;
