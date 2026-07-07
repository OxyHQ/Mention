import { getRedisClient } from '../../utils/redis';
import { withRedisFallback, ensureRedisConnected } from '../../utils/redisHelpers';
import { logger } from '../../utils/logger';
import { MCP_ACCESS_TOKEN_TTL_SECONDS } from '../config/constants';

/**
 * MCP token revocation blocklist.
 *
 * When a connection is revoked (or its token family is rotated on refresh) the
 * connection's current `jti` is added to a Redis blocklist keyed
 * `mcp:revoked:<jti>`. `middleware/mcpAuth.ts` checks {@link isRevoked} on every
 * request AFTER verifying the JWT signature, so an access token whose family was
 * revoked stops working before its natural expiry.
 *
 * The blocklist entry only needs to outlive the access token: once the token
 * expires the signature check rejects it anyway, so entries carry a TTL equal to
 * the access-token lifetime (plus a small skew margin). Redis is a soft
 * dependency — if it is unavailable the check fails OPEN for reads
 * ({@link isRevoked} returns `false`) but writes are best-effort; callers that
 * need a hard revocation guarantee also stamp `revokedAt` on the connection
 * document (checked on refresh).
 */

const KEY_PREFIX = 'mcp:revoked:';
// Add a margin so an entry never expires before the token it blocks (clock skew
// + the token's own exp validation grace).
const BLOCKLIST_TTL_SECONDS = MCP_ACCESS_TOKEN_TTL_SECONDS + 60;

function keyFor(jti: string): string {
  return `${KEY_PREFIX}${jti}`;
}

/** Add a token-family `jti` to the revocation blocklist. Best-effort on Redis outage. */
export async function revokeJti(jti: string): Promise<void> {
  if (!jti) return;
  const redis = getRedisClient();
  await withRedisFallback(
    redis,
    async () => {
      const connected = await ensureRedisConnected(redis);
      if (!connected) return;
      await redis.setEx(keyFor(jti), BLOCKLIST_TTL_SECONDS, '1');
    },
    undefined,
    'mcpRevokeJti',
  ).catch((error: unknown) => {
    logger.warn('[McpRevocation] Failed to write blocklist entry', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
  });
}

/**
 * Whether a token-family `jti` is revoked. Fails OPEN (returns `false`) when
 * Redis is unavailable — the refresh path's `revokedAt` check on the connection
 * document is the durable backstop for hard revocation.
 */
export async function isRevoked(jti: string): Promise<boolean> {
  if (!jti) return false;
  const redis = getRedisClient();
  return withRedisFallback(
    redis,
    async () => {
      const connected = await ensureRedisConnected(redis);
      if (!connected) return false;
      const value = await redis.get(keyFor(jti));
      return value !== null && value !== undefined;
    },
    false,
    'mcpIsRevoked',
  );
}
