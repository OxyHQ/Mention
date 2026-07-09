import crypto from 'crypto';
import { McpConnection, type IMcpConnection } from '../models/McpConnection';
import { getRedisClient } from '../../utils/redis';
import { withRedisFallback, ensureRedisConnected } from '../../utils/redisHelpers';
import { logger } from '../../utils/logger';
import { MCP_LINK_TOKEN_TTL_SECONDS } from '../config/constants';

/**
 * Multi-account MCP bundles: one Claude connector URL can authorize several
 * Mention accounts. Claude holds the primary OAuth token; linked accounts are
 * server-side grants sharing the same `bundleId`. The active account for each
 * request is stored in Redis (`mcp:bundle:active:{bundleId}`).
 */

const ACTIVE_KEY_PREFIX = 'mcp:bundle:active:';

function activeKey(bundleId: string): string {
  return `${ACTIVE_KEY_PREFIX}${bundleId}`;
}

function getSecret(): string {
  const secret = process.env.MENTION_MCP_JWT_SECRET;
  if (!secret || secret.length === 0) {
    throw new Error('MENTION_MCP_JWT_SECRET is not configured');
  }
  return secret;
}

/** Lazy backfill for connections created before bundles shipped. */
export async function ensureBundleFields(connection: IMcpConnection): Promise<IMcpConnection> {
  if (connection.bundleId) {
    return connection;
  }
  const bundleId = crypto.randomUUID();
  connection.bundleId = bundleId;
  connection.isBundlePrimary = true;
  await connection.save();
  await setActiveAccount(bundleId, connection.oxyUserId);
  return connection;
}

/** Load a non-revoked connection by token-family id. */
export async function findConnectionByJti(jti: string): Promise<IMcpConnection | null> {
  const row = await McpConnection.findOne({ jti, revokedAt: null });
  if (!row) return null;
  return ensureBundleFields(row);
}

export async function setActiveAccount(bundleId: string, oxyUserId: string): Promise<void> {
  const redis = getRedisClient();
  await withRedisFallback(
    redis,
    async () => {
      const connected = await ensureRedisConnected(redis);
      if (!connected) return;
      await redis.set(activeKey(bundleId), oxyUserId);
    },
    undefined,
    'mcpSetActiveAccount',
  ).catch((error: unknown) => {
    logger.warn('[McpBundle] Failed to set active account', {
      bundleId,
      reason: error instanceof Error ? error.message : 'unknown',
    });
  });
}

export async function getActiveAccount(bundleId: string, fallbackOxyUserId: string): Promise<string> {
  const redis = getRedisClient();
  return withRedisFallback(
    redis,
    async () => {
      const connected = await ensureRedisConnected(redis);
      if (!connected) return fallbackOxyUserId;
      const value = await redis.get(activeKey(bundleId));
      return value && value.length > 0 ? value : fallbackOxyUserId;
    },
    fallbackOxyUserId,
    'mcpGetActiveAccount',
  );
}

/** Verify the active account is a non-revoked member of the bundle. */
export async function resolveActiveBundleMember(
  bundleId: string,
  primaryOxyUserId: string,
  activeOxyUserId: string,
): Promise<string> {
  const member = await McpConnection.findOne({
    bundleId,
    oxyUserId: activeOxyUserId,
    revokedAt: null,
  }).lean();
  if (member) {
    return activeOxyUserId;
  }
  return primaryOxyUserId;
}

export interface McpBundleContext {
  bundleId: string;
  primaryUserId: string;
  activeUserId: string;
  clientId: string;
  jti: string;
}

export async function resolveBundleContext(
  jti: string,
  tokenSub: string,
): Promise<McpBundleContext | null> {
  const connection = await findConnectionByJti(jti);
  if (!connection) return null;
  if (connection.oxyUserId !== tokenSub) {
    return null;
  }

  const bundleId = connection.bundleId;
  const primaryUserId = connection.oxyUserId;
  const rawActive = await getActiveAccount(bundleId, primaryUserId);
  const activeUserId = await resolveActiveBundleMember(bundleId, primaryUserId, rawActive);

  if (activeUserId !== rawActive) {
    await setActiveAccount(bundleId, activeUserId);
  }

  return {
    bundleId,
    primaryUserId,
    activeUserId,
    clientId: connection.clientId,
    jti,
  };
}

export interface LinkTokenPayload {
  bundleId: string;
  clientId: string;
  exp: number;
  sig: string;
}

export function signLinkToken(bundleId: string, clientId: string): string {
  const exp = Math.floor(Date.now() / 1000) + MCP_LINK_TOKEN_TTL_SECONDS;
  const payload = `${bundleId}:${clientId}:${exp}`;
  const sig = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
  const encoded = Buffer.from(JSON.stringify({ bundleId, clientId, exp, sig } satisfies LinkTokenPayload)).toString(
    'base64url',
  );
  return encoded;
}

export function verifyLinkToken(token: string): { bundleId: string; clientId: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as LinkTokenPayload;
    if (!parsed.bundleId || !parsed.clientId || !parsed.exp || !parsed.sig) {
      return null;
    }
    if (parsed.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    const payload = `${parsed.bundleId}:${parsed.clientId}:${parsed.exp}`;
    const expected = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
    const a = Buffer.from(expected);
    const b = Buffer.from(parsed.sig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return null;
    }
    return { bundleId: parsed.bundleId, clientId: parsed.clientId };
  } catch {
    return null;
  }
}

export async function listBundleMembers(bundleId: string): Promise<IMcpConnection[]> {
  return McpConnection.find({ bundleId, revokedAt: null }).sort({ isBundlePrimary: -1, createdAt: 1 });
}
