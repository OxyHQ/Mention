import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PRESENCE_CLEANUP_INTERVAL_MS,
  PRESENCE_HEARTBEAT_INTERVAL_MS,
  PresenceRegistry,
  type DistributedPresencePort,
  type PresencePayload,
} from '../../runtime/presenceRegistry';

/**
 * The presence bookkeeping that used to live inline in `server.ts`, where the
 * only way to reach it was to boot an HTTP server and a Socket.IO server.
 */

function createDistributedPresence(): DistributedPresencePort & {
  isOnline: ReturnType<typeof vi.fn>;
  markOnline: ReturnType<typeof vi.fn>;
  markOffline: ReturnType<typeof vi.fn>;
  getBulk: ReturnType<typeof vi.fn>;
  heartbeat: ReturnType<typeof vi.fn>;
} {
  return {
    isOnline: vi.fn().mockResolvedValue(false),
    markOnline: vi.fn().mockResolvedValue(undefined),
    markOffline: vi.fn().mockResolvedValue(undefined),
    getBulk: vi.fn().mockResolvedValue({}),
    heartbeat: vi.fn().mockResolvedValue(undefined),
  };
}

describe('PresenceRegistry', () => {
  let distributedPresence: ReturnType<typeof createDistributedPresence>;
  let connectedSocketIds: Set<string>;
  let emitted: Array<{ userId: string; payload: PresencePayload }>;
  let registry: PresenceRegistry;

  beforeEach(() => {
    distributedPresence = createDistributedPresence();
    connectedSocketIds = new Set<string>();
    emitted = [];
    registry = new PresenceRegistry({
      distributedPresence,
      isSocketConnected: (socketId) => connectedSocketIds.has(socketId),
      emitPresence: (userId, payload) => {
        emitted.push({ userId, payload });
      },
    });
  });

  const track = (userId: string, ...socketIds: string[]) => {
    registry.onlineUsers.set(userId, new Set(socketIds));
    for (const socketId of socketIds) connectedSocketIds.add(socketId);
  };

  describe('local view', () => {
    it('reports a user with at least one tracked socket as online', () => {
      track('user-1', 'socket-a');
      expect(registry.isUserOnline('user-1')).toBe(true);
    });

    it('reports an unknown user as offline', () => {
      expect(registry.isUserOnline('nobody')).toBe(false);
    });

    it('reports a user whose socket set emptied as offline', () => {
      registry.onlineUsers.set('user-1', new Set());
      expect(registry.isUserOnline('user-1')).toBe(false);
    });
  });

  describe('distributed answers', () => {
    it('passes the local view to the distributed lookup as its fallback', async () => {
      track('user-1', 'socket-a');
      distributedPresence.isOnline.mockResolvedValue(true);

      await expect(registry.isOnline('user-1')).resolves.toBe(true);
      expect(distributedPresence.isOnline).toHaveBeenCalledWith('user-1', true);
    });

    it('falls back to false for a user this instance does not hold', async () => {
      await registry.isOnline('user-9');
      expect(distributedPresence.isOnline).toHaveBeenCalledWith('user-9', false);
    });

    it('hands getBulk a per-user local fallback predicate', async () => {
      track('user-1', 'socket-a');
      distributedPresence.getBulk.mockResolvedValue({ 'user-1': true, 'user-2': false });

      await expect(registry.getBulk(['user-1', 'user-2'])).resolves.toEqual({
        'user-1': true,
        'user-2': false,
      });
      const [userIds, localFallback] = distributedPresence.getBulk.mock.calls[0];
      expect(userIds).toEqual(['user-1', 'user-2']);
      expect(localFallback('user-1')).toBe(true);
      expect(localFallback('user-2')).toBe(false);
    });
  });

  describe('broadcastPresence', () => {
    it('emits the userId, the state and an ISO timestamp', () => {
      registry.broadcastPresence('user-1', true);

      expect(emitted).toHaveLength(1);
      expect(emitted[0].userId).toBe('user-1');
      expect(emitted[0].payload.userId).toBe('user-1');
      expect(emitted[0].payload.online).toBe(true);
      expect(new Date(emitted[0].payload.timestamp).toISOString()).toBe(
        emitted[0].payload.timestamp,
      );
    });
  });

  describe('runCleanup', () => {
    it('keeps sockets that are still connected', async () => {
      track('user-1', 'socket-a', 'socket-b');

      await registry.runCleanup();

      expect(registry.onlineUsers.get('user-1')).toEqual(new Set(['socket-a', 'socket-b']));
      expect(distributedPresence.markOffline).not.toHaveBeenCalled();
    });

    it('drops a stale socket id without taking a still-connected user offline', async () => {
      track('user-1', 'socket-a', 'socket-b');
      connectedSocketIds.delete('socket-b');

      await registry.runCleanup();

      expect(registry.onlineUsers.get('user-1')).toEqual(new Set(['socket-a']));
      expect(distributedPresence.markOffline).not.toHaveBeenCalled();
      expect(emitted).toHaveLength(0);
    });

    it('removes a user whose every socket went away and releases the lease', async () => {
      track('user-1', 'socket-a');
      connectedSocketIds.clear();

      await registry.runCleanup();

      expect(registry.onlineUsers.has('user-1')).toBe(false);
      expect(distributedPresence.markOffline).toHaveBeenCalledWith('user-1');
      expect(emitted).toEqual([
        { userId: 'user-1', payload: expect.objectContaining({ userId: 'user-1', online: false }) },
      ]);
    });

    it('does not broadcast offline while another instance still holds the user', async () => {
      track('user-1', 'socket-a');
      connectedSocketIds.clear();
      distributedPresence.isOnline.mockResolvedValue(true);

      await registry.runCleanup();

      expect(distributedPresence.markOffline).toHaveBeenCalledWith('user-1');
      expect(distributedPresence.isOnline).toHaveBeenCalledWith('user-1', false);
      expect(emitted).toHaveLength(0);
    });

    it('sweeps every tracked user in one pass', async () => {
      track('user-1', 'socket-a');
      track('user-2', 'socket-b');
      track('user-3', 'socket-c');
      connectedSocketIds.delete('socket-a');
      connectedSocketIds.delete('socket-c');

      await registry.runCleanup();

      expect([...registry.onlineUsers.keys()]).toEqual(['user-2']);
      expect(distributedPresence.markOffline.mock.calls.map(([userId]) => userId)).toEqual([
        'user-1',
        'user-3',
      ]);
    });
  });

  describe('runHeartbeat', () => {
    it('refreshes the lease of exactly the users this instance holds', async () => {
      track('user-1', 'socket-a');
      track('user-2', 'socket-b');

      await registry.runHeartbeat();

      expect(distributedPresence.heartbeat).toHaveBeenCalledTimes(1);
      expect([...distributedPresence.heartbeat.mock.calls[0][0]]).toEqual(['user-1', 'user-2']);
    });
  });

  describe('housekeeping timers', () => {
    it('unrefs both intervals so they never hold the event loop open', () => {
      const probe = setInterval(() => undefined, 60_000);
      const unref = vi.spyOn(Object.getPrototypeOf(probe), 'unref');
      clearInterval(probe);

      try {
        registry.startHousekeeping();
        expect(unref).toHaveBeenCalledTimes(2);
      } finally {
        registry.stopHousekeeping();
        unref.mockRestore();
      }
    });

    it('runs the cleanup sweep and the heartbeat on their own cadences', () => {
      vi.useFakeTimers();
      try {
        track('user-1', 'socket-a');
        registry.startHousekeeping();

        vi.advanceTimersByTime(PRESENCE_HEARTBEAT_INTERVAL_MS);
        expect(distributedPresence.heartbeat).toHaveBeenCalledTimes(1);

        connectedSocketIds.clear();
        vi.advanceTimersByTime(
          PRESENCE_CLEANUP_INTERVAL_MS - PRESENCE_HEARTBEAT_INTERVAL_MS,
        );
        expect(distributedPresence.markOffline).toHaveBeenCalledWith('user-1');

        registry.stopHousekeeping();
        distributedPresence.heartbeat.mockClear();
        vi.advanceTimersByTime(PRESENCE_HEARTBEAT_INTERVAL_MS * 10);
        expect(distributedPresence.heartbeat).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('drainOffline', () => {
    it('releases every held lease and empties the local view', async () => {
      track('user-1', 'socket-a');
      track('user-2', 'socket-b');

      await registry.drainOffline();

      expect(distributedPresence.markOffline.mock.calls.map(([userId]) => userId)).toEqual([
        'user-1',
        'user-2',
      ]);
      expect(registry.onlineUsers.size).toBe(0);
    });

    it('still empties the local view when a lease release rejects', async () => {
      track('user-1', 'socket-a');
      distributedPresence.markOffline.mockRejectedValue(new Error('redis down'));

      await expect(registry.drainOffline()).resolves.toBeUndefined();
      expect(registry.onlineUsers.size).toBe(0);
    });
  });
});
