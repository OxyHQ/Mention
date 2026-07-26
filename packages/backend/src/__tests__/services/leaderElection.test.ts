import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Logic self-audit for LeaderElection. We model a single shared Redis key in a
 * plain JS object and back getRedisClient() with a fake that implements the
 * exact subset of node-redis used by LeaderElection: set (NX/PX), eval (the
 * renew + release Lua scripts), ping, and isReady. Two independent
 * LeaderElection instances then contend for the same fake key, proving the
 * cross-task semantics deterministically.
 */

interface FakeKVEntry {
  value: string;
  expireAt: number; // epoch ms; Infinity = no expiry
}

class FakeRedis {
  isReady = true;
  private store = new Map<string, FakeKVEntry>();

  private isLive(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (Date.now() >= entry.expireAt) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  async ping(): Promise<string> {
    if (!this.isReady) throw new Error('not ready');
    return 'PONG';
  }

  async set(
    key: string,
    value: string,
    options?: { condition?: string; expiration?: { type: string; value: number } },
  ): Promise<'OK' | null> {
    const px = options?.expiration?.type === 'PX' ? options.expiration.value : Infinity;
    const expireAt = px === Infinity ? Infinity : Date.now() + px;
    if (options?.condition === 'NX' && this.isLive(key)) {
      return null;
    }
    this.store.set(key, { value, expireAt });
    return 'OK';
  }

  async eval(
    script: string,
    opts: { keys: string[]; arguments: string[] },
  ): Promise<number> {
    const key = opts.keys[0];
    const me = opts.arguments[0];
    const live = this.isLive(key);
    const owner = live ? this.store.get(key)!.value : undefined;

    if (script.includes('pexpire')) {
      // RENEW: extend TTL iff we still own it.
      if (owner === me) {
        const ttl = Number(opts.arguments[1]);
        this.store.set(key, { value: me, expireAt: Date.now() + ttl });
        return 1;
      }
      return 0;
    }
    // RELEASE: delete iff we still own it.
    if (owner === me) {
      this.store.delete(key);
      return 1;
    }
    return 0;
  }

  // --- test helpers ---
  forceExpire(key: string): void {
    const entry = this.store.get(key);
    if (entry) entry.expireAt = 0;
  }

  currentOwner(key: string): string | undefined {
    return this.isLive(key) ? this.store.get(key)!.value : undefined;
  }
}

const fakeRedis = new FakeRedis();

vi.mock('../../utils/redis', () => ({
  getRedisClient: () => fakeRedis,
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Import AFTER mocks are registered.
import { LeaderElection } from '../../services/LeaderElection';

const LOCK_KEY = 'mention:scheduler:leader';

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('LeaderElection', () => {
  beforeEach(() => {
    fakeRedis.isReady = true;
    // Clear any residual key between tests.
    fakeRedis.forceExpire(LOCK_KEY);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a single task acquires leadership and runs schedulers', async () => {
    const onAcquire = vi.fn();
    const onLose = vi.fn();
    const node = new LeaderElection();

    await node.start(onAcquire, onLose);

    expect(node.leader).toBe(true);
    expect(onAcquire).toHaveBeenCalledTimes(1);
    expect(onLose).not.toHaveBeenCalled();
    expect(fakeRedis.currentOwner(LOCK_KEY)).toBe(node.id);

    await node.stop();
  });

  it('a second task does NOT run schedulers while the first holds the lock', async () => {
    const a = new LeaderElection();
    const b = new LeaderElection();
    const aAcquire = vi.fn();
    const bAcquire = vi.fn();

    await a.start(aAcquire, vi.fn());
    await b.start(bAcquire, vi.fn());

    expect(a.leader).toBe(true);
    expect(b.leader).toBe(false);
    expect(aAcquire).toHaveBeenCalledTimes(1);
    expect(bAcquire).not.toHaveBeenCalled();
    expect(fakeRedis.currentOwner(LOCK_KEY)).toBe(a.id);

    await a.stop();
    await b.stop();
  });

  it('a follower takes over after the leader lock expires (failover)', async () => {
    const a = new LeaderElection();
    const b = new LeaderElection();
    const bAcquire = vi.fn();

    await a.start(vi.fn(), vi.fn());
    await b.start(bAcquire, vi.fn());
    expect(a.leader).toBe(true);
    expect(b.leader).toBe(false);

    // Simulate leader A's task dying: it stops renewing, so the lock expires.
    // (We expire the key directly to model TTL lapse without real timers.)
    fakeRedis.forceExpire(LOCK_KEY);

    // Drive B's follower tick manually via its public start-loop behavior:
    // call the private tick by triggering another acquire window.
    // Use a fresh start on a third instance to assert acquisition is possible,
    // then assert B can win by invoking its retry path through the timer.
    await (b as unknown as { tick: () => Promise<void> }).tick();

    expect(b.leader).toBe(true);
    expect(bAcquire).toHaveBeenCalledTimes(1);
    expect(fakeRedis.currentOwner(LOCK_KEY)).toBe(b.id);

    await a.stop();
    await b.stop();
  });

  it('SIGTERM/stop() on the leader releases the lock so a follower can acquire it', async () => {
    const a = new LeaderElection();
    const b = new LeaderElection();
    const bAcquire = vi.fn();

    await a.start(vi.fn(), vi.fn());
    await b.start(bAcquire, vi.fn());
    expect(a.leader).toBe(true);

    // Leader receives SIGTERM → stop() → atomic owner-checked release.
    await a.stop();
    expect(fakeRedis.currentOwner(LOCK_KEY)).toBeUndefined();

    // Follower's next tick acquires immediately.
    await (b as unknown as { tick: () => Promise<void> }).tick();
    expect(b.leader).toBe(true);
    expect(bAcquire).toHaveBeenCalledTimes(1);

    await b.stop();
  });

  it('stops singleton schedulers before releasing the leader lock', async () => {
    const onLoseStarted = deferred();
    const allowOnLose = deferred();
    const node = new LeaderElection();
    const onLose = vi.fn(async () => {
      onLoseStarted.resolve();
      await allowOnLose.promise;
    });

    await node.start(vi.fn(), onLose);
    const stopping = node.stop();
    await onLoseStarted.promise;

    expect(node.leader).toBe(false);
    expect(fakeRedis.currentOwner(LOCK_KEY)).toBe(node.id);

    allowOnLose.resolve();
    await stopping;

    expect(onLose).toHaveBeenCalledTimes(1);
    expect(fakeRedis.currentOwner(LOCK_KEY)).toBeUndefined();
  });

  it('waits for an acquiring tick and never becomes leader after shutdown starts', async () => {
    fakeRedis.isReady = false;
    const onAcquire = vi.fn();
    const onLose = vi.fn();
    const node = new LeaderElection();
    await node.start(onAcquire, onLose);

    fakeRedis.isReady = true;
    const setStarted = deferred();
    const allowSet = deferred();
    const originalSet = fakeRedis.set.bind(fakeRedis);
    const setSpy = vi.spyOn(fakeRedis, 'set').mockImplementation(
      async (key, value, options) => {
        setStarted.resolve();
        await allowSet.promise;
        return originalSet(key, value, options);
      },
    );

    const tick = (node as unknown as { tick: () => Promise<void> }).tick();
    await setStarted.promise;
    let stopFinished = false;
    const stopping = node.stop().then(() => {
      stopFinished = true;
    });
    await Promise.resolve();

    expect(stopFinished).toBe(false);

    allowSet.resolve();
    await Promise.all([tick, stopping]);

    expect(node.leader).toBe(false);
    expect(onAcquire).not.toHaveBeenCalled();
    expect(onLose).not.toHaveBeenCalled();
    expect(fakeRedis.currentOwner(LOCK_KEY)).toBeUndefined();

    const callsAfterStop = setSpy.mock.calls.length;
    await (node as unknown as { tick: () => Promise<void> }).tick();
    expect(setSpy).toHaveBeenCalledTimes(callsAfterStop);
  });

  it('does not reacquire after shutdown starts during a lost-leadership callback', async () => {
    const onAcquire = vi.fn();
    const onLoseStarted = deferred();
    const allowOnLose = deferred();
    const node = new LeaderElection();
    const onLose = vi.fn(async () => {
      onLoseStarted.resolve();
      await allowOnLose.promise;
    });

    await node.start(onAcquire, onLose);
    fakeRedis.forceExpire(LOCK_KEY);

    const tick = (node as unknown as { tick: () => Promise<void> }).tick();
    await onLoseStarted.promise;
    const stopping = node.stop();
    allowOnLose.resolve();
    await Promise.all([tick, stopping]);

    expect(onAcquire).toHaveBeenCalledTimes(1);
    expect(onLose).toHaveBeenCalledTimes(1);
    expect(node.leader).toBe(false);
    expect(fakeRedis.currentOwner(LOCK_KEY)).toBeUndefined();
  });

  it('fails closed and acquires normally after Redis recovers', async () => {
    fakeRedis.isReady = false;
    const onAcquire = vi.fn();
    const node = new LeaderElection();

    await node.start(onAcquire, vi.fn());

    expect(node.leader).toBe(false);
    expect(onAcquire).not.toHaveBeenCalled();

    fakeRedis.isReady = true;
    await (node as unknown as { tick: () => Promise<void> }).tick();
    expect(node.leader).toBe(true);
    expect(onAcquire).toHaveBeenCalledTimes(1);

    await node.stop();
  });

  it('steps down immediately when Redis cannot verify a renewal', async () => {
    const onLose = vi.fn();
    const node = new LeaderElection();
    await node.start(vi.fn(), onLose);
    expect(node.leader).toBe(true);

    fakeRedis.isReady = false;
    await (node as unknown as { tick: () => Promise<void> }).tick();

    expect(node.leader).toBe(false);
    expect(onLose).toHaveBeenCalledTimes(1);
    fakeRedis.isReady = true;
    await node.stop();
  });

  it('a leader that loses the lock to another owner steps down and stops schedulers', async () => {
    const a = new LeaderElection();
    const onLose = vi.fn();

    await a.start(vi.fn(), onLose);
    expect(a.leader).toBe(true);

    // Simulate a different task stealing the key (e.g. after a long pause):
    // overwrite the owner, then drive A's renew tick.
    await fakeRedis.set(LOCK_KEY, 'some-other-instance', {
      expiration: { type: 'PX', value: 30_000 },
    });

    await (a as unknown as { tick: () => Promise<void> }).tick();

    expect(a.leader).toBe(false);
    expect(onLose).toHaveBeenCalledTimes(1);

    await a.stop();
  });
});
