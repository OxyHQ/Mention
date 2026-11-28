/**
 * `announceFederationHandles`: one `Update(Person)` per account whose handle
 * changed since it was last announced, batched, paced against the delivery
 * queue, idempotent, and the same run for the rollback. Every dependency is an
 * in-memory fake, so each rule is pinned without a database or a queue.
 */
import { describe, expect, it } from 'bun:test';
import { createFederationHandlePolicy } from '../../connectors/activitypub/federationHandleDomain';
import {
  type AnnounceDependencies,
  type AnnounceOptions,
  type AnnouncedHandleStore,
  DEFAULT_ANNOUNCE_OPTIONS,
  announceFederationHandles,
  announceOptionsFromEnv,
  integerOption,
} from '../../scripts/announceFederationHandles';

const EARTH = 'mention.earth';
const ORG = 'mention.org';

/** Local federating accounts: Oxy id → username. `carol` never federated (no key pair). */
const LOCAL: Record<string, string> = {
  u1: 'alice',
  u2: 'bob',
  u3: 'OxyQA',
  u4: 'dave',
  u5: 'erin',
};
const NOT_FEDERATING: Record<string, string> = { u9: 'carol' };

class MemoryStore implements AnnouncedHandleStore {
  readonly records = new Map<string, string>();
  locked = false;
  lockCalls = 0;
  async all() {
    return new Map(this.records);
  }
  async set(id: string, acct: string) {
    this.records.set(id, acct);
  }
  async delete(id: string) {
    this.records.delete(id);
  }
  async lock() {
    this.lockCalls += 1;
    if (this.locked) return false;
    this.locked = true;
    return true;
  }
  async unlock() {
    this.locked = false;
  }
}

interface Harness {
  deps: AnnounceDependencies;
  store: MemoryStore;
  announced: Array<[string, string]>;
  sleeps: number[];
  lookups: string[][];
  clock: { now: number };
}

function harness(
  accounts: 'all' | string[],
  overrides: Partial<AnnounceDependencies> & {
    handleDomain?: string;
    store?: MemoryStore;
    sharingOff?: string[];
    backlog?: number[];
  } = {},
): Harness {
  const store = overrides.store ?? new MemoryStore();
  const announced: Array<[string, string]> = [];
  const sleeps: number[] = [];
  const lookups: string[][] = [];
  const clock = { now: 0 };
  const backlog = [...(overrides.backlog ?? [])];
  const byUsername = new Map(
    Object.entries(LOCAL).map(([id, username]) => [username.toLowerCase(), id]),
  );
  const deps: AnnounceDependencies = {
    policy: createFederationHandlePolicy({
      federationDomain: EARTH,
      handleDomain: overrides.handleDomain ?? ORG,
      accounts,
    }),
    store,
    async *localActorIdPages() {
      const ids = Object.keys(LOCAL);
      yield ids.slice(0, 2);
      yield ids.slice(2);
    },
    localActorIdForUsername: async (username) => byUsername.get(username.toLowerCase()) ?? null,
    usernamesFor: async (ids) => {
      lookups.push([...ids]);
      const all = { ...LOCAL, ...NOT_FEDERATING };
      return new Map(ids.filter((id) => all[id]).map((id) => [id, all[id]]));
    },
    isSharingEnabled: async (id) => !(overrides.sharingOff ?? []).includes(id),
    announce: async (id, username) => {
      announced.push([id, username]);
    },
    deliveryBacklog: async () => (backlog.length > 0 ? (backlog.shift() as number) : 0),
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.now += ms;
    },
    now: () => clock.now,
    ...overrides,
  };
  return { deps, store, announced, sleeps, lookups, clock };
}

const LIVE: AnnounceOptions = { ...DEFAULT_ANNOUNCE_OPTIONS, dryRun: false, pauseMs: 1_000 };
const DRY: AnnounceOptions = { ...LIVE, dryRun: true };

describe('announceFederationHandles', () => {
  it('sends nothing while the handle domain is off and nothing was announced', async () => {
    for (const h of [harness([], {}), harness('all', { handleDomain: EARTH })]) {
      const result = await announceFederationHandles(LIVE, h.deps);
      expect(result.candidates).toBe(0);
      expect(h.announced).toEqual([]);
      expect(h.store.records.size).toBe(0);
    }
  });

  it('announces the QA account only, and records the handle it announced', async () => {
    const h = harness(['oxyqa']);
    const result = await announceFederationHandles(LIVE, h.deps);
    expect(h.announced).toEqual([['u3', 'OxyQA']]);
    expect(result).toMatchObject({ candidates: 1, announced: 1, unchanged: 0, failed: 0 });
    expect(h.store.records).toEqual(new Map([['u3', `oxyqa@${ORG}`]]));
  });

  it('skips a listed username that is unknown or never federated', async () => {
    const h = harness(['oxyqa', 'carol', 'nobody']);
    const result = await announceFederationHandles(LIVE, h.deps);
    expect(h.announced).toEqual([['u3', 'OxyQA']]);
    expect(result.unresolvable).toBe(2);
  });

  it('is idempotent: a second run sends nothing', async () => {
    const h = harness('all');
    const first = await announceFederationHandles(LIVE, h.deps);
    expect(first.announced).toBe(5);
    h.announced.length = 0;
    const second = await announceFederationHandles(LIVE, h.deps);
    expect(second).toMatchObject({ candidates: 5, announced: 0, unchanged: 5 });
    expect(h.announced).toEqual([]);
  });

  it('widening the rollout announces only the newly switched accounts', async () => {
    const store = new MemoryStore();
    await announceFederationHandles(LIVE, harness(['oxyqa'], { store }).deps);
    const all = harness('all', { store });
    const result = await announceFederationHandles(LIVE, all.deps);
    expect(all.announced.map(([id]) => id)).toEqual(['u1', 'u2', 'u4', 'u5']);
    expect(result).toMatchObject({ announced: 4, unchanged: 1 });
  });

  it('rolls back with the same run: recorded accounts get the old handle again, records cleared', async () => {
    const store = new MemoryStore();
    await announceFederationHandles(LIVE, harness('all', { store }).deps);
    expect(store.records.size).toBe(5);

    // FEDERATION_HANDLE_DOMAIN unset (or the list emptied) and deployed.
    const rollback = harness([], { store });
    const result = await announceFederationHandles(LIVE, rollback.deps);
    expect(rollback.announced.map(([id]) => id).sort()).toEqual(['u1', 'u2', 'u3', 'u4', 'u5']);
    expect(result).toMatchObject({ candidates: 5, announced: 5 });
    expect(store.records.size).toBe(0);

    // And then nothing more.
    const again = harness([], { store });
    expect((await announceFederationHandles(LIVE, again.deps)).candidates).toBe(0);
    expect(again.announced).toEqual([]);
  });

  it('narrowing the rollout announces the old handle for the dropped accounts', async () => {
    const store = new MemoryStore();
    await announceFederationHandles(LIVE, harness(['oxyqa', 'alice'], { store }).deps);
    const narrowed = harness(['oxyqa'], { store });
    await announceFederationHandles(LIVE, narrowed.deps);
    expect(narrowed.announced).toEqual([['u1', 'alice']]);
    expect(store.records).toEqual(new Map([['u3', `oxyqa@${ORG}`]]));
  });

  it('clears a stale record that already matches the federation domain without sending', async () => {
    const store = new MemoryStore();
    store.records.set('u1', `alice@${EARTH}`);
    const h = harness([], { store });
    const result = await announceFederationHandles(LIVE, h.deps);
    expect(h.announced).toEqual([]);
    expect(result).toMatchObject({ unchanged: 1, cleared: 1 });
    expect(store.records.size).toBe(0);
  });

  it('announces again after a rename (the recorded acct no longer matches)', async () => {
    const store = new MemoryStore();
    store.records.set('u1', `alice-old@${ORG}`);
    const h = harness(['alice'], { store });
    await announceFederationHandles(LIVE, h.deps);
    expect(h.announced).toEqual([['u1', 'alice']]);
    expect(store.records.get('u1')).toBe(`alice@${ORG}`);
  });

  it('a dry run counts, sends nothing, writes nothing and takes no lock', async () => {
    const store = new MemoryStore();
    store.records.set('u1', `alice@${EARTH}`);
    const h = harness('all', { store });
    const result = await announceFederationHandles(DRY, h.deps);
    expect(result).toMatchObject({ wouldAnnounce: 5, announced: 0, cleared: 0 });
    expect(h.announced).toEqual([]);
    expect(store.records).toEqual(new Map([['u1', `alice@${EARTH}`]]));
    expect(store.lockCalls).toBe(0);
  });

  it('skips an account whose sharing is off and keeps its record for later', async () => {
    const store = new MemoryStore();
    store.records.set('u2', `bob@${ORG}`);
    const h = harness([], { store, sharingOff: ['u2'] });
    const result = await announceFederationHandles(LIVE, h.deps);
    expect(h.announced).toEqual([]);
    expect(result.sharingOff).toBe(1);
    expect(store.records.get('u2')).toBe(`bob@${ORG}`);
  });

  it('counts an id Oxy could not read and retries it next run', async () => {
    const store = new MemoryStore();
    store.records.set('u-missing', `ghost@${ORG}`);
    const h = harness([], { store });
    const result = await announceFederationHandles(LIVE, h.deps);
    expect(result.unresolvable).toBe(1);
    expect(store.records.has('u-missing')).toBe(true);
  });

  it('keeps going past a failed announcement, leaves it unrecorded, and reports it', async () => {
    const h = harness('all');
    h.deps.announce = async (id, username) => {
      if (id === 'u2') throw new Error('oxy down');
      h.announced.push([id, username]);
    };
    const result = await announceFederationHandles(LIVE, h.deps);
    expect(result).toMatchObject({ announced: 4, failed: 1 });
    expect(h.store.records.has('u2')).toBe(false);
    expect(h.store.locked).toBe(false);
  });

  it('works in batches, pausing between them and looking usernames up per batch', async () => {
    const h = harness('all');
    await announceFederationHandles({ ...LIVE, batchSize: 2, pauseMs: 7_000 }, h.deps);
    expect(h.lookups).toEqual([['u1', 'u2'], ['u3', 'u4'], ['u5']]);
    expect(h.sleeps).toEqual([7_000, 7_000]);
  });

  it('waits while the delivery queue is over its limit', async () => {
    const h = harness(['oxyqa'], { backlog: [9_000, 6_000, 10] });
    const result = await announceFederationHandles(
      { ...LIVE, maxDeliveryBacklog: 5_000, backlogPollMs: 30_000 },
      h.deps,
    );
    expect(h.sleeps).toEqual([30_000, 30_000]);
    expect(result.announced).toBe(1);
  });

  it('stops between batches at the runtime limit, and a re-run finishes the rest', async () => {
    const store = new MemoryStore();
    const h = harness('all', { store });
    const stopped = await announceFederationHandles(
      { ...LIVE, batchSize: 2, pauseMs: 60_000, maxRuntimeMs: 90_000 },
      h.deps,
    );
    expect(stopped).toMatchObject({ stopped: true, announced: 4 });
    expect(store.locked).toBe(false);
    const rest = harness('all', { store });
    const finished = await announceFederationHandles(LIVE, rest.deps);
    expect(rest.announced).toEqual([['u5', 'erin']]);
    expect(finished.stopped).toBe(false);
  });

  it('stops rather than wait forever on a full queue', async () => {
    const h = harness(['oxyqa'], { backlog: Array(100).fill(1_000_000) });
    const result = await announceFederationHandles(
      { ...LIVE, maxRuntimeMs: 60_000, backlogPollMs: 30_000 },
      h.deps,
    );
    expect(result).toMatchObject({ stopped: true, announced: 0 });
  });

  it('refuses to run beside another run', async () => {
    const store = new MemoryStore();
    store.locked = true;
    const h = harness(['oxyqa'], { store });
    await expect(announceFederationHandles(LIVE, h.deps)).rejects.toThrow('another run');
    expect(h.announced).toEqual([]);
  });
});

describe('the run options', () => {
  it('defaults to a dry run with the documented pacing', () => {
    expect(announceOptionsFromEnv({})).toEqual({ ...DEFAULT_ANNOUNCE_OPTIONS, dryRun: true });
    expect(announceOptionsFromEnv({ DRY_RUN: 'false', BATCH_SIZE: '10' })).toMatchObject({
      dryRun: false,
      batchSize: 10,
    });
    expect(announceOptionsFromEnv({ DRY_RUN: 'no' }).dryRun).toBe(true);
  });

  it('refuses an option out of bounds', () => {
    expect(() => integerOption('0', 25, { minimum: 1, maximum: 200 })).toThrow();
    expect(() => integerOption('2.5', 25, { minimum: 1, maximum: 200 })).toThrow();
    expect(() => integerOption('abc', 25, { minimum: 1, maximum: 200 })).toThrow();
    expect(integerOption(' ', 25, { minimum: 1, maximum: 200 })).toBe(25);
    expect(() => announceOptionsFromEnv({ BATCH_SIZE: '500' })).toThrow();
  });
});
