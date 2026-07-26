import { hostname } from 'os';
import { randomUUID } from 'crypto';
import { getRedisClient } from '../utils/redis';
import { logger } from '../utils/logger';

/**
 * LeaderElection — Redis-backed leader election so that in-process schedulers
 * (cron-style background jobs) run on EXACTLY ONE backend task at a time.
 *
 * Why: the Mention backend runs several unconditional per-process schedulers
 * (FeedJobScheduler, TrendingService, PostClassificationService, TopicService,
 * FederationJobScheduler, plus the media-cache worker and eviction jobs owned
 * by FederationJobScheduler). When the backend runs at
 * 2+ ECS tasks for HA / zero-downtime deploys, those schedulers would all
 * double-run — double trending writes, double federation sync, races. This
 * service gates them behind a single distributed lock so only the elected
 * leader runs them.
 *
 * Algorithm (single Redis key, fencing by unique per-process instance id):
 *  - Acquire: `SET <key> <instanceId> NX PX <LOCK_TTL_MS>`. If it succeeds we
 *    become leader and run `onAcquire()` (starts schedulers).
 *  - Renew (every LOCK_TTL_MS/3 while leader): an atomic Lua check-and-pexpire
 *    extends the lock ONLY if we still own it. If we discover we no longer own
 *    it (clock skew, a pause longer than the TTL, manual takeover), we run
 *    `onLose()` (stops schedulers) and drop back to follower mode.
 *  - Follow (every LOCK_TTL_MS/3 while follower): keep retrying the NX acquire.
 *    If the current leader's task dies, its lock expires after at most
 *    LOCK_TTL_MS and a follower wins the next acquire, becoming leader within
 *    ~LOCK_TTL_MS.
 *  - Stop: clear timers and, if we are the leader, release the lock with an
 *    atomic owner-checked DEL so failover is near-instant on graceful shutdown.
 *
 * Fail-safe (Redis unavailable): singleton schedulers remain paused until this
 * process can acquire and renew the distributed lease. The follower retry loop
 * continues, so recovery does not require a redeploy and a partition can never
 * create multiple active leaders.
 */

/** Lock key — single key shared across all backend tasks. */
const LOCK_KEY = 'mention:scheduler:leader';

/** Lock TTL. If the leader stops renewing (crash/network partition), the lock
 *  auto-expires after this window and a follower can take over. */
const LOCK_TTL_MS = 30_000;

/** Renew/retry cadence — a third of the TTL so the leader renews well before
 *  expiry (≈10s), giving 2 renewal attempts of headroom before the lock would
 *  lapse. Followers retry acquisition at the same cadence. */
const TICK_INTERVAL_MS = Math.floor(LOCK_TTL_MS / 3);

/**
 * Lua: extend the lock's TTL only if this instance still owns it.
 * Returns 1 if renewed (still owner), 0 otherwise (lost ownership).
 */
const RENEW_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
else
  return 0
end`;

/**
 * Lua: delete the lock only if this instance still owns it.
 * Returns 1 if released, 0 otherwise (we no longer owned it).
 */
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end`;

type LeaderCallback = () => void | Promise<void>;

export class LeaderElection {
  /** Unique identity for this process. Used as the lock value (fencing token). */
  private readonly instanceId: string = `${hostname()}:${process.pid}:${randomUUID()}`;

  private isLeader = false;
  private started = false;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  private onAcquire: LeaderCallback | null = null;
  private onLose: LeaderCallback | null = null;

  /** Shared promise so overlapping ticks and shutdown can await the same work. */
  private tickInFlight: Promise<void> | null = null;
  private stopInFlight: Promise<void> | null = null;

  /**
   * Begin leader election.
   *
   * @param onAcquire Invoked when this process BECOMES the leader (start schedulers).
   * @param onLose    Invoked when this process STOPS being the leader (stop schedulers).
   */
  async start(onAcquire: LeaderCallback, onLose: LeaderCallback): Promise<void> {
    if (this.stopInFlight) {
      await this.stopInFlight;
    }
    if (this.started) {
      logger.warn('[LeaderElection] start() called more than once — ignoring');
      return;
    }
    this.started = true;
    this.onAcquire = onAcquire;
    this.onLose = onLose;

    // Without a distributed lease singleton work must fail closed. The retry
    // loop stays alive so schedulers recover automatically with Redis.
    const redisAvailable = await this.isRedisAvailable();
    if (!redisAvailable) {
      logger.warn(
        `[LeaderElection] Redis unavailable at boot — singleton schedulers are paused ` +
          `until a distributed lease can be acquired (instance=${this.instanceId})`,
      );
    } else {
      await this.tick();
    }

    // stop() may have run while Redis or the initial tick was in flight.
    if (!this.started) return;
    this.tickTimer = setInterval(() => {
      void this.tick();
    }, TICK_INTERVAL_MS);
    // Do not keep the event loop alive solely for the election timer.
    if (typeof this.tickTimer.unref === 'function') {
      this.tickTimer.unref();
    }
  }

  /**
   * Stop election. Clears timers and, if leader, releases the lock atomically so
   * another task can take over immediately (graceful shutdown / SIGTERM).
   */
  async stop(): Promise<void> {
    if (this.stopInFlight) {
      await this.stopInFlight;
      return;
    }
    if (!this.started && !this.tickInFlight && !this.isLeader) return;

    this.started = false;

    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }

    const stopping = this.finishStop();
    this.stopInFlight = stopping;
    try {
      await stopping;
    } finally {
      if (this.stopInFlight === stopping) {
        this.stopInFlight = null;
      }
    }
  }

  private async finishStop(): Promise<void> {
    // A tick may be renewing or acquiring the lease. Let it reach a fenced
    // stopping point before changing scheduler or lock state.
    await this.tickInFlight;

    if (this.isLeader) {
      this.isLeader = false;
      await this.invokeOnLose();
    }

    // Keep the lease until singleton work has stopped. releaseLock is
    // owner-checked, so calling it after a follower-side shutdown is harmless
    // and also cleans up a lease acquired by a tick that raced with stop().
    await this.releaseLock();
  }

  /** Whether this process is currently the scheduler leader. */
  get leader(): boolean {
    return this.isLeader;
  }

  /** Exposed for diagnostics/logging. */
  get id(): string {
    return this.instanceId;
  }

  /**
   * One iteration of the election loop. As leader: renew (or step down if lost).
   * As follower: try to acquire.
   */
  private async tick(): Promise<void> {
    if (!this.started) return;
    if (this.tickInFlight) {
      await this.tickInFlight;
      return;
    }

    const inFlight = this.runTick();
    this.tickInFlight = inFlight;
    try {
      await inFlight;
    } finally {
      if (this.tickInFlight === inFlight) {
        this.tickInFlight = null;
      }
    }
  }

  private async runTick(): Promise<void> {
    try {
      if (!this.started) return;
      if (this.isLeader) {
        const stillOwner = await this.renewLock();
        // stop() owns the transition and release from this point onward.
        if (!this.started) return;
        if (!stillOwner) {
          // We lost the lock unexpectedly — step down and stop schedulers.
          logger.warn(
            `[LeaderElection] Lost leadership (renewal found a different owner) (instance=${this.instanceId})`,
          );
          this.isLeader = false;
          await this.invokeOnLose();
          // Immediately try to re-acquire in the same tick (best effort).
          if (this.started) {
            await this.tryAcquire();
          }
        }
      } else {
        await this.tryAcquire();
      }
    } catch (error) {
      // Losing the ability to prove ownership must stop singleton work.
      if (this.isLeader) {
        this.isLeader = false;
        await this.invokeOnLose();
      }
      logger.warn('[LeaderElection] Election tick failed (will retry next tick)', error);
    }
  }

  /** Try to acquire the lock via SET NX PX. On success, become leader. */
  private async tryAcquire(): Promise<void> {
    if (!this.started) return;
    const acquired = await this.acquireLock();
    if (!acquired) return;

    // stop() may have started while SET NX was in flight. Never start
    // schedulers for a stopped election; give the lease back immediately.
    if (!this.started) {
      await this.releaseLock();
      return;
    }
    await this.becomeLeader();
  }

  /** Transition to leader and start schedulers. */
  private async becomeLeader(): Promise<void> {
    if (!this.started) {
      await this.releaseLock();
      return;
    }
    this.isLeader = true;
    logger.info(`[LeaderElection] Acquired scheduler leadership (instance=${this.instanceId})`);
    await this.invokeOnAcquire();
  }

  private async invokeOnAcquire(): Promise<void> {
    if (!this.onAcquire) return;
    try {
      await this.onAcquire();
    } catch (error) {
      logger.error('[LeaderElection] onAcquire callback threw', error);
    }
  }

  private async invokeOnLose(): Promise<void> {
    logger.info(`[LeaderElection] Lost leadership — stopping schedulers (instance=${this.instanceId})`);
    if (!this.onLose) return;
    try {
      await this.onLose();
    } catch (error) {
      logger.error('[LeaderElection] onLose callback threw', error);
    }
  }

  // --- Redis primitives ---------------------------------------------------

  /** Verify Redis is connected and responsive. */
  private async isRedisAvailable(): Promise<boolean> {
    try {
      const client = getRedisClient();
      if (!client.isReady) return false;
      await client.ping();
      return true;
    } catch {
      return false;
    }
  }

  /** `SET key instanceId NX PX TTL` → true if we won the lock. */
  private async acquireLock(): Promise<boolean> {
    const client = getRedisClient();
    if (!client.isReady) return false;
    const result = await client.set(LOCK_KEY, this.instanceId, {
      condition: 'NX',
      expiration: { type: 'PX', value: LOCK_TTL_MS },
    });
    // node-redis returns 'OK' on success, null when NX condition fails.
    return result === 'OK';
  }

  /** Atomic owner-checked PEXPIRE. Returns true if we still own the lock. */
  private async renewLock(): Promise<boolean> {
    const client = getRedisClient();
    if (!client.isReady) {
      return false;
    }
    const result = await client.eval(RENEW_SCRIPT, {
      keys: [LOCK_KEY],
      arguments: [this.instanceId, String(LOCK_TTL_MS)],
    });
    return result === 1;
  }

  /** Atomic owner-checked DEL. Releases the lock only if we still own it. */
  private async releaseLock(): Promise<void> {
    try {
      const client = getRedisClient();
      if (!client.isReady) return;
      await client.eval(RELEASE_SCRIPT, {
        keys: [LOCK_KEY],
        arguments: [this.instanceId],
      });
    } catch (error) {
      logger.warn('[LeaderElection] Failed to release lock on shutdown', error);
    }
  }
}

export const leaderElection = new LeaderElection();
