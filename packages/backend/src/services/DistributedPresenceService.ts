import type { RedisClientType } from 'redis';
import { logger } from '../utils/logger';

const PRESENCE_PREFIX = 'presence:v1:user:';
const DEFAULT_TTL_SECONDS = 90;

function validUserId(userId: string): boolean {
  return /^[a-zA-Z0-9_.:@-]{1,160}$/.test(userId);
}

export class DistributedPresenceService {
  constructor(
    private readonly getClient: () => RedisClientType,
    private readonly instanceId: string,
    private readonly ttlSeconds = DEFAULT_TTL_SECONDS,
  ) {}

  async markOnline(userId: string): Promise<void> {
    if (!validUserId(userId)) return;
    const client = this.getClient();
    if (!client?.isReady) return;
    const key = `${PRESENCE_PREFIX}${userId}`;
    const expiresAt = Date.now() + this.ttlSeconds * 1_000;
    try {
      await client
        .multi()
        .zRemRangeByScore(key, 0, Date.now())
        .zAdd(key, { score: expiresAt, value: this.instanceId })
        .expire(key, this.ttlSeconds * 2)
        .exec();
    } catch (error) {
      logger.debug('[presence] failed to refresh distributed presence', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async markOffline(userId: string): Promise<void> {
    if (!validUserId(userId)) return;
    const client = this.getClient();
    if (!client?.isReady) return;
    try {
      await client.zRem(`${PRESENCE_PREFIX}${userId}`, this.instanceId);
    } catch (error) {
      logger.debug('[presence] failed to remove distributed presence', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async isOnline(userId: string, localFallback: boolean): Promise<boolean> {
    if (!validUserId(userId)) return false;
    const client = this.getClient();
    if (!client?.isReady) return localFallback;
    const key = `${PRESENCE_PREFIX}${userId}`;
    try {
      const transaction = await client
        .multi()
        .zRemRangeByScore(key, 0, Date.now())
        .zCard(key)
        .exec();
      const activeInstances = Number(transaction[1] ?? 0);
      return activeInstances > 0;
    } catch (error) {
      logger.debug('[presence] distributed lookup degraded to local state', {
        reason: error instanceof Error ? error.message : String(error),
      });
      return localFallback;
    }
  }

  async getBulk(
    userIds: readonly string[],
    localFallback: (userId: string) => boolean,
  ): Promise<Record<string, boolean>> {
    const uniqueIds = [...new Set(userIds.filter(validUserId))].slice(0, 100);
    const results = await Promise.all(
      uniqueIds.map(async (userId) => [
        userId,
        await this.isOnline(userId, localFallback(userId)),
      ] as const),
    );
    return Object.fromEntries(results);
  }

  async heartbeat(userIds: Iterable<string>): Promise<void> {
    await Promise.all([...userIds].map((userId) => this.markOnline(userId)));
  }
}
