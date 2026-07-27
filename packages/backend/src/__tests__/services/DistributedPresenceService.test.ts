import { describe, expect, it } from 'vitest';
import type { RedisClientType } from 'redis';
import { DistributedPresenceService } from '../../services/DistributedPresenceService';

function fakeRedis(): RedisClientType {
  const sortedSets = new Map<string, Map<string, number>>();
  const client = {
    isReady: true,
    zRem: async (key: string, member: string) => {
      const existed = sortedSets.get(key)?.delete(member) ?? false;
      return existed ? 1 : 0;
    },
    multi: () => {
      const operations: Array<() => number> = [];
      const chain = {
        zRemRangeByScore(key: string, min: number, max: number) {
          operations.push(() => {
            let removed = 0;
            for (const [member, score] of sortedSets.get(key) ?? []) {
              if (score >= min && score <= max) {
                sortedSets.get(key)?.delete(member);
                removed++;
              }
            }
            return removed;
          });
          return chain;
        },
        zAdd(key: string, entry: { score: number; value: string }) {
          operations.push(() => {
            const set = sortedSets.get(key) ?? new Map<string, number>();
            const existed = set.has(entry.value);
            set.set(entry.value, entry.score);
            sortedSets.set(key, set);
            return existed ? 0 : 1;
          });
          return chain;
        },
        expire() {
          operations.push(() => 1);
          return chain;
        },
        zCard(key: string) {
          operations.push(() => sortedSets.get(key)?.size ?? 0);
          return chain;
        },
        async exec() {
          return operations.map((operation) => operation());
        },
      };
      return chain;
    },
  };
  return client as unknown as RedisClientType;
}

describe('DistributedPresenceService', () => {
  it('keeps a user online while any application instance has a live lease', async () => {
    const redis = fakeRedis();
    const first = new DistributedPresenceService(() => redis, 'instance-a');
    const second = new DistributedPresenceService(() => redis, 'instance-b');

    await first.markOnline('user-1');
    await second.markOnline('user-1');
    await first.markOffline('user-1');

    await expect(first.isOnline('user-1', false)).resolves.toBe(true);

    await second.markOffline('user-1');
    await expect(first.isOnline('user-1', true)).resolves.toBe(false);
  });

  it('falls back to local state without issuing commands when Redis is degraded', async () => {
    const redis = { isReady: false } as RedisClientType;
    const presence = new DistributedPresenceService(() => redis, 'instance-a');

    await expect(presence.isOnline('user-1', true)).resolves.toBe(true);
    await expect(presence.isOnline('user-1', false)).resolves.toBe(false);
  });
});
