import { describe, expect, it } from 'vitest';
import { isWithinOutboxSyncCooldown, shouldForceUntrackedOutboxSync } from '../../connectors/activitypub/outboxSyncCooldown';

const COOLDOWN_MS = 15 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 5, 25, 12, 0, 0);

describe('outbox sync cooldown', () => {
  it('honors recent cooldown stamps for untracked positive-count outboxes', () => {
    const recentSync = new Date(NOW_MS - 60_000);

    expect(shouldForceUntrackedOutboxSync({
      postsCount: 3,
      lastOutboxSyncAt: recentSync,
      nowMs: NOW_MS,
      cooldownMs: COOLDOWN_MS,
    })).toBe(false);
    expect(isWithinOutboxSyncCooldown(recentSync, COOLDOWN_MS, NOW_MS)).toBe(true);
  });

  it('forces one sync for stale untracked positive-count outboxes', () => {
    expect(shouldForceUntrackedOutboxSync({
      postsCount: 3,
      lastOutboxSyncAt: new Date(NOW_MS - COOLDOWN_MS - 1),
      nowMs: NOW_MS,
      cooldownMs: COOLDOWN_MS,
    })).toBe(true);
  });

  it('does not force a sync for tracked or empty outboxes', () => {
    expect(shouldForceUntrackedOutboxSync({
      outboxStatus: 'complete',
      postsCount: 3,
      nowMs: NOW_MS,
      cooldownMs: COOLDOWN_MS,
    })).toBe(false);
    expect(shouldForceUntrackedOutboxSync({
      postsCount: 0,
      nowMs: NOW_MS,
      cooldownMs: COOLDOWN_MS,
    })).toBe(false);
  });
});
