import { hostname } from 'os';
import { randomUUID } from 'crypto';
import { getRedisClient } from '../utils/redis';
import { logger } from '../utils/logger';

/**
 * LeaderElection — Redis-backed leader election so that in-process schedulers
 * (cron-style background jobs) run on EXACTLY ONE backend task at a time.
 *
 * Why: the Mention backend runs several unconditional per-process schedulers
 * (FeedJobScheduler, TrendingService, TopicExtractionService, TopicService,
 * FederationJobScheduler, RecordingCleanupService, plus the media-cache worker
 * and eviction jobs owned by FederationJobScheduler). When the backend runs at
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
 * Fail-safe (Redis unavailable): if Redis cannot be reached at boot, we do NOT
 * silently leave schedulers off forever — that would stop the whole cron
 * system. Instead we log a clear WARNING and RUN the schedulers anyway in a
 * degraded single-task fallback. This matches the effective behavior at 1 task
 * (that task is always the leader) and is strictly safer than running zero
 * schedulers. With Redis unavailable AND 2 tasks, both would run schedulers —
 * but a Redis outage already degrades the platform, and double-running cron is
 * far less harmful than no cron at all. Once Redis recovers, a redeploy / task
 * restart re-establishes single-leader election.
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
  /** True when running schedulers without Redis arbitration (degraded mode). */
  private degradedFallback = false;

  private tickTimer: ReturnType<typeof setInterval> | null = null;

  private onAcquire: LeaderCallback | null = null;
  private onLose: LeaderCallback | null = null;

  /** Guard so overlapping ticks (slow Redis) never run the loop body twice. */
  private tickInFlight = false;

  /**
   * Begin leader election.
   *
   * @param onAcquire Invoked when this process BECOMES the leader (start schedulers).
   * @param onLose    Invoked when this process STOPS being the leader (stop schedulers).
   */
  async start(onAcquire: LeaderCallback, onLose: LeaderCallback): Promise<void> {
    if (this.started) {
      logger.warn('[LeaderElection] start() called more than once — ignoring');
      return;
    }
    this.started = true;
    this.onAcquire = onAcquire;
    this.onLose = onLose;

    // Probe Redis once. If it is unreachable at boot, run schedulers in the
    // degraded single-task fallback rather than leaving cron off entirely.
    const redisAvailable = await this.isRedisAvailable();
    if (!redisAvailable) {
      this.degradedFallback = true;
      logger.warn(
        `[LeaderElection] Redis unavailable at boot — running schedulers WITHOUT distributed lock ` +
          `(degraded single-task fallback, instance=${this.instanceId}). ` +
          `If more than one task is running, schedulers will double-run until Redis recovers + tasks restart.`,
      );
      await this.becomeLeader();
      return;
    }

    // Attempt the first acquisition immediately, then run the tick loop.
    await this.tick();
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
    if (!this.started) return;
    this.started = false;

    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }

    // In degraded fallback there is no Redis lock to release; just stop schedulers.
    if (this.degradedFallback) {
      if (this.isLeader) {
        this.isLeader = false;
        await this.invokeOnLose();
      }
      return;
    }

    if (this.isLeader) {
      this.isLeader = false;
      // Release the lock first so a follower can acquire it right away, then
      // stop our own schedulers.
      await this.releaseLock();
      await this.invokeOnLose();
    }
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
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      if (this.isLeader) {
        const stillOwner = await this.renewLock();
        if (!stillOwner) {
          // We lost the lock unexpectedly — step down and stop schedulers.
          logger.warn(
            `[LeaderElection] Lost leadership (renewal found a different owner) (instance=${this.instanceId})`,
          );
          this.isLeader = false;
          await this.invokeOnLose();
          // Immediately try to re-acquire in the same tick (best effort).
          await this.tryAcquire();
        }
      } else {
        await this.tryAcquire();
      }
    } catch (error) {
      // A transient Redis error must not crash the loop. If we were leader we
      // keep running schedulers (the lock will simply expire if Redis stays
      // down and another task takes over once it recovers). Log and move on.
      logger.warn('[LeaderElection] Election tick failed (will retry next tick)', error);
    } finally {
      this.tickInFlight = false;
    }
  }

  /** Try to acquire the lock via SET NX PX. On success, become leader. */
  private async tryAcquire(): Promise<void> {
    const acquired = await this.acquireLock();
    if (acquired) {
      await this.becomeLeader();
    }
  }

  /** Transition to leader and start schedulers. */
  private async becomeLeader(): Promise<void> {
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
      // Cannot verify ownership while Redis is down. Assume we are still leader
      // to keep schedulers running (degraded). The lock will expire on its own
      // if Redis stays down, letting a healthy task take over after recovery.
      return true;
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
