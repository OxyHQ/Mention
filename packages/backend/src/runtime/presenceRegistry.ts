import { logger } from '../utils/logger';

/** Validates that tracked socket IDs are still actually connected. */
export const PRESENCE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
export const PRESENCE_HEARTBEAT_INTERVAL_MS = 30_000;

export interface PresencePayload {
  userId: string;
  online: boolean;
  timestamp: string;
}

/**
 * The slice of {@link DistributedPresenceService} this registry uses. Declared
 * here so the bookkeeping can be exercised without a Redis-backed service.
 */
export interface DistributedPresencePort {
  isOnline(userId: string, localFallback: boolean): Promise<boolean>;
  markOnline(userId: string): Promise<void>;
  markOffline(userId: string): Promise<void>;
  getBulk(
    userIds: readonly string[],
    localFallback: (userId: string) => boolean,
  ): Promise<Record<string, boolean>>;
  heartbeat(userIds: Iterable<string>): Promise<void>;
}

/** Who is asking about presence: an authenticated socket's account and verified bearer. */
export interface PresenceViewer {
  id: string;
  accessToken: string;
}

/**
 * Whose presence a viewer may learn — the one decision every presence answer
 * and broadcast goes through (`services/presencePolicy.ts`).
 */
export interface PresencePolicyPort {
  /**
   * Of `userIds`, those `viewer` may not see online. `null` is "anyone": a
   * broadcast reaches every subscriber, so only what applies to all of them.
   * Never rejects; an unanswerable check hides.
   */
  hiddenFrom(viewer: PresenceViewer | null, userIds: readonly string[]): Promise<Set<string>>;
}

export interface PresenceRegistryDeps {
  distributedPresence: DistributedPresencePort;
  policy: PresencePolicyPort;
  /** True while this process still holds a live connection with that socket id. */
  isSocketConnected(socketId: string): boolean;
  /** Deliver a presence change to whoever subscribed to this user. */
  emitPresence(userId: string, payload: PresencePayload): void;
}

/**
 * Per-process presence bookkeeping: which users this instance currently holds a
 * socket for, plus the housekeeping timers that keep that view honest.
 *
 * A user may have several concurrent connections, so the local view is a map of
 * userId to socket ids. It is only ever the LOCAL half of the answer — the
 * fleet-wide answer comes from {@link DistributedPresencePort}, with the local
 * view as its fallback when Redis is degraded.
 */
export class PresenceRegistry {
  /** Shared with `registerSocketPresence`, which mutates it per connection. */
  readonly onlineUsers = new Map<string, Set<string>>();
  readonly distributedPresence: DistributedPresencePort;

  private readonly policy: PresencePolicyPort;
  private readonly isSocketConnected: (socketId: string) => boolean;
  private readonly emitPresence: (userId: string, payload: PresencePayload) => void;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  constructor(deps: PresenceRegistryDeps) {
    this.distributedPresence = deps.distributedPresence;
    this.policy = deps.policy;
    this.isSocketConnected = deps.isSocketConnected;
    this.emitPresence = deps.emitPresence;
  }

  /** Local-only answer: does this instance hold a socket for the user? */
  isUserOnline(userId: string): boolean {
    const sockets = this.onlineUsers.get(userId);
    return sockets !== undefined && sockets.size > 0;
  }

  /** Whether `viewer` may see `userId` online at all, which is what a subscription needs. */
  async mayWatch(viewer: PresenceViewer, userId: string): Promise<boolean> {
    return !(await this.policy.hiddenFrom(viewer, [userId])).has(userId);
  }

  /**
   * Fleet-wide answer for what `viewer` may know, degrading to this instance's
   * own view. A user hidden from the viewer reads as offline — the same answer
   * as being away, so hiding is not itself disclosed.
   */
  async onlineFor(
    viewer: PresenceViewer,
    userIds: readonly string[],
  ): Promise<Record<string, boolean>> {
    const hidden = await this.policy.hiddenFrom(viewer, userIds);
    const shown = userIds.filter((userId) => !hidden.has(userId));
    const online =
      shown.length > 0
        ? await this.distributedPresence.getBulk(shown, (userId) => this.isUserOnline(userId))
        : {};
    return Object.fromEntries(userIds.map((userId) => [userId, online[userId] === true]));
  }

  /** Tell subscribers about a change, unless the user hides their online status. */
  async broadcastPresence(userId: string, online: boolean): Promise<void> {
    if ((await this.policy.hiddenFrom(null, [userId])).has(userId)) return;
    this.emitPresence(userId, { userId, online, timestamp: new Date().toISOString() });
  }

  /**
   * Drop socket ids this process no longer holds, and take any user left with
   * none of them offline.
   *
   * The returned promise covers the distributed markOffline/broadcast follow-up
   * only; the local map is already consistent when this returns. The interval
   * deliberately does not await it — a rejection surfaces through the process
   * unhandled-rejection handler exactly as it did before.
   */
  runCleanup(): Promise<void> {
    let cleanedUsers = 0;
    let cleanedSockets = 0;
    const pending: Array<Promise<void>> = [];

    for (const [userId, sockets] of this.onlineUsers.entries()) {
      // Remove socket IDs that are no longer connected
      for (const socketId of sockets) {
        if (!this.isSocketConnected(socketId)) {
          sockets.delete(socketId);
          cleanedSockets++;
        }
      }
      // Remove user entry if no valid sockets remain
      if (sockets.size === 0) {
        this.onlineUsers.delete(userId);
        pending.push(
          this.distributedPresence.markOffline(userId).then(async () => {
            if (!(await this.distributedPresence.isOnline(userId, false))) {
              await this.broadcastPresence(userId, false);
            }
          }),
        );
        cleanedUsers++;
      }
    }

    if (cleanedUsers > 0 || cleanedSockets > 0) {
      logger.debug(
        `Presence cleanup: removed ${cleanedSockets} stale sockets, ${cleanedUsers} users now offline`,
      );
    }
    return Promise.all(pending).then(() => undefined);
  }

  /** Refresh the distributed lease for every user this instance still holds. */
  runHeartbeat(): Promise<void> {
    return this.distributedPresence.heartbeat(this.onlineUsers.keys());
  }

  startHousekeeping(): void {
    this.cleanupInterval = setInterval(() => {
      void this.runCleanup();
    }, PRESENCE_CLEANUP_INTERVAL_MS);
    // Never keep the event loop (or a test run) alive solely for this housekeeping timer.
    this.cleanupInterval.unref?.();

    this.heartbeatInterval = setInterval(() => {
      void this.runHeartbeat();
    }, PRESENCE_HEARTBEAT_INTERVAL_MS);
    this.heartbeatInterval.unref?.();
  }

  stopHousekeeping(): void {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.cleanupInterval = null;
    this.heartbeatInterval = null;
  }

  /** Shutdown step: release every distributed lease this instance holds. */
  async drainOffline(): Promise<void> {
    await Promise.allSettled(
      [...this.onlineUsers.keys()].map((userId) => this.distributedPresence.markOffline(userId)),
    );
    this.onlineUsers.clear();
  }
}
