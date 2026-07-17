import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * Offline tests for the irreversible `purgeGoneFederatedActors` one-shot.
 *
 * Every model, `signedFetch`, `deleteFederatedActorIdentity`, `connectToDatabase`
 * and `mongoose.disconnect` are mocked so the REAL paging, re-verify gate, cascade
 * ORDER, and the partial-failure anchor-keeping run WITHOUT MongoDB or a network.
 * A shared `callLog` records the exact execution order of every destructive step so
 * the tests can assert:
 *   - the full delete order (Mention refs → Oxy identity → FederatedActor anchor),
 *   - a re-verified-live (200) actor is NOT purged and its tombstone is cleared,
 *   - the Oxy identity delete runs AFTER all Mention refs and strictly BEFORE the
 *     FederatedActor anchor is dropped (and the anchor is the very last step),
 *   - a transient Oxy failure KEEPS the anchor (never orphans the Oxy user),
 *   - `--dry-run` performs zero destructive work.
 */

interface PostRow {
  _id: mongoose.Types.ObjectId;
}
interface ActorRow {
  _id: mongoose.Types.ObjectId;
  uri: string;
  acct: string;
  oxyUserId?: string;
}
interface SignedConfig {
  status: number;
  ok: boolean;
  statusText: string;
  throwErr?: Error;
}
type OxyOutcome = 'deleted' | 'absent' | 'skipped' | 'failed';

const h = vi.hoisted(() => {
  const callLog: string[] = [];
  const state: {
    actors: ActorRow[];
    authoredPosts: PostRow[];
    boostPosts: PostRow[];
    signed: SignedConfig;
    oxyOutcome: OxyOutcome;
  } = {
    actors: [],
    authoredPosts: [],
    boostPosts: [],
    signed: { status: 410, ok: false, statusText: 'Gone' },
    oxyOutcome: 'deleted',
  };

  // A count query that is both directly awaitable (the driver's `countDocuments`)
  // and `.exec()`-able (the `countOrDelete` helper's dry-run path).
  const countQuery = (n: number): Promise<number> & { exec: () => Promise<number> } =>
    Object.assign(Promise.resolve(n), { exec: async () => n });

  // A simple model: `deleteMany` (records order) + `countDocuments`.
  const makeSimple = (label: string) => ({
    deleteMany: vi.fn((_filter: unknown) => ({
      exec: async () => {
        callLog.push(label);
        return { deletedCount: 1 };
      },
    })),
    countDocuments: vi.fn((_filter: unknown) => countQuery(1)),
  });

  const federatedActor = {
    countDocuments: vi.fn((_filter: unknown) => countQuery(state.actors.length)),
    find: vi.fn((query: { _id?: { $gt?: unknown } }) => ({
      sort: () => ({
        limit: () => ({
          lean: async () => (query._id?.$gt ? [] : state.actors),
        }),
      }),
    })),
    updateOne: vi.fn(async (_filter: unknown, _update: unknown) => {
      callLog.push('FederatedActor.updateOne');
      return { modifiedCount: 1 };
    }),
    deleteOne: vi.fn(async (_filter: unknown) => {
      callLog.push('FederatedActor.deleteOne');
      return { deletedCount: 1 };
    }),
  };

  const post = {
    // Authored lookup carries `$or`; the boost lookup does not.
    find: vi.fn((filter: { $or?: unknown }) => ({
      lean: async () => (filter.$or ? state.authoredPosts : state.boostPosts),
    })),
    deleteMany: vi.fn((_filter: unknown) => ({
      exec: async () => {
        callLog.push('Post.deleteMany');
        return { deletedCount: 1 };
      },
    })),
    updateMany: vi.fn((_filter: unknown, _update: unknown) => ({
      exec: async () => {
        callLog.push('Post.updateMany');
        return { modifiedCount: 1 };
      },
    })),
    countDocuments: vi.fn((_filter: unknown) => countQuery(1)),
  };

  const oxyDelete = vi.fn(async (_id: string): Promise<OxyOutcome> => {
    callLog.push('oxy-delete');
    return state.oxyOutcome;
  });

  const signedFetch = vi.fn(async (_uri: string, _ct: string) => {
    if (state.signed.throwErr) throw state.signed.throwErr;
    return { status: state.signed.status, ok: state.signed.ok, statusText: state.signed.statusText };
  });

  return {
    callLog,
    state,
    federatedActor,
    post,
    oxyDelete,
    signedFetch,
    like: makeSimple('Like'),
    bookmark: makeSimple('Bookmark'),
    federatedFollow: makeSimple('FederatedFollow'),
    entityFollow: makeSimple('EntityFollow'),
    notification: makeSimple('Notification'),
    block: makeSimple('Block'),
    userSettings: makeSimple('UserSettings'),
    userBehavior: makeSimple('UserBehavior'),
    userFeedPreference: makeSimple('UserFeedPreference'),
    authorFollowerSnapshot: makeSimple('AuthorFollowerSnapshot'),
    actorKeyPair: makeSimple('ActorKeyPair'),
    mentionUserNode: makeSimple('MentionUserNode'),
    mentionRepoHead: makeSimple('MentionRepoHead'),
    mentionSignedRecord: makeSimple('MentionSignedRecord'),
    mentionNodeIngestWitness: makeSimple('MentionNodeIngestWitness'),
  };
});

vi.mock('../../utils/database', () => ({ connectToDatabase: vi.fn(async () => undefined) }));
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../connectors/activitypub/helpers', () => ({ signedFetch: h.signedFetch }));
vi.mock('../../connectors/activitypub/constants', () => ({ AP_CONTENT_TYPE: 'application/activity+json' }));
vi.mock('../../connectors/identity', () => ({ deleteFederatedActorIdentity: h.oxyDelete }));

vi.mock('../../models/FederatedActor', () => ({ default: h.federatedActor }));
vi.mock('../../models/Post', () => ({ Post: h.post }));
vi.mock('../../models/Like', () => ({ default: h.like }));
vi.mock('../../models/Bookmark', () => ({ default: h.bookmark }));
vi.mock('../../models/FederatedFollow', () => ({ default: h.federatedFollow }));
vi.mock('../../models/EntityFollow', () => ({ EntityFollow: h.entityFollow }));
vi.mock('../../models/Notification', () => ({ default: h.notification }));
vi.mock('../../models/Block', () => ({ default: h.block }));
vi.mock('../../models/UserSettings', () => ({ default: h.userSettings }));
vi.mock('../../models/UserBehavior', () => ({ default: h.userBehavior }));
vi.mock('../../models/UserFeedPreference', () => ({ default: h.userFeedPreference }));
vi.mock('../../models/AuthorFollowerSnapshot', () => ({ AuthorFollowerSnapshot: h.authorFollowerSnapshot }));
vi.mock('../../models/ActorKeyPair', () => ({ default: h.actorKeyPair }));
vi.mock('../../models/MentionUserNode', () => ({ default: h.mentionUserNode }));
vi.mock('../../models/MentionRepoHead', () => ({ default: h.mentionRepoHead }));
vi.mock('../../models/MentionSignedRecord', () => ({ default: h.mentionSignedRecord }));
vi.mock('../../models/MentionNodeIngestWitness', () => ({ default: h.mentionNodeIngestWitness }));

vi.mock('mongoose', async () => {
  const actual = await vi.importActual<typeof import('mongoose')>('mongoose');
  return { ...actual, default: { ...actual.default, disconnect: vi.fn(async () => undefined) } };
});

import purgeGoneFederatedActors from '../../scripts/purgeGoneFederatedActors';

const originalArgv = process.argv;

function makeActor(oxyUserId: string = 'X'): ActorRow {
  return {
    _id: new mongoose.Types.ObjectId(),
    uri: 'https://mastodon.social/users/ghost',
    acct: 'ghost@mastodon.social',
    oxyUserId,
  };
}

/** Run the one-shot with the given argv flags (default: a live run). */
async function run(args: string[] = []): Promise<void> {
  process.argv = ['bun', 'purgeGoneFederatedActors', ...args];
  await purgeGoneFederatedActors();
}

/** Assert every label is present and their first occurrences strictly ascend. */
function expectOrder(callLog: string[], labels: string[]): void {
  let prev = -1;
  for (const label of labels) {
    const idx = callLog.indexOf(label);
    expect(idx, `expected "${label}" in call log`).toBeGreaterThan(prev);
    prev = idx;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  h.callLog.length = 0;
  h.state.actors = [];
  h.state.authoredPosts = [];
  h.state.boostPosts = [];
  h.state.signed = { status: 410, ok: false, statusText: 'Gone' };
  h.state.oxyOutcome = 'deleted';
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`unexpected process.exit(${String(code)})`);
  });
});

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

describe('purgeGoneFederatedActors', () => {
  it('cascades a confirmed-gone actor in order: Mention refs → Oxy identity → FederatedActor anchor', async () => {
    h.state.actors = [makeActor('X')];
    h.state.authoredPosts = [{ _id: new mongoose.Types.ObjectId() }];
    h.state.boostPosts = [{ _id: new mongoose.Types.ObjectId() }];

    await run();

    // Step 1 (posts) → 2 (mentions) → 4 (follows) → 5-7 → 8 → 9 (oxy) → 10 (anchor).
    expectOrder(h.callLog, [
      'Bookmark',
      'Post.updateMany',
      'FederatedFollow',
      'EntityFollow',
      'Notification',
      'Block',
      'UserSettings',
      'MentionNodeIngestWitness',
      'oxy-delete',
      'FederatedActor.deleteOne',
    ]);

    // X's posts + their boosts are deleted before any follow edges are touched.
    expect(h.callLog.indexOf('Post.deleteMany')).toBeGreaterThanOrEqual(0);
    expect(h.callLog.indexOf('Post.deleteMany')).toBeLessThan(h.callLog.indexOf('FederatedFollow'));
  });

  it('drops the FederatedActor anchor LAST, strictly AFTER a confirmed Oxy identity delete', async () => {
    h.state.actors = [makeActor('X')];

    await run();

    const oxyIdx = h.callLog.indexOf('oxy-delete');
    expect(oxyIdx).toBeGreaterThanOrEqual(0);
    // Everything AFTER the Oxy delete is ONLY the anchor drop — nothing else, so the
    // anchor can never be dropped before the Oxy identity is confirmed gone.
    expect(h.callLog.slice(oxyIdx + 1)).toEqual(['FederatedActor.deleteOne']);
    expect(h.callLog[h.callLog.length - 1]).toBe('FederatedActor.deleteOne');
  });

  it('re-verify gate: a resurrected (200) actor is NOT purged and its tombstone is cleared', async () => {
    const actor = makeActor('X');
    h.state.actors = [actor];
    h.state.signed = { status: 200, ok: true, statusText: 'OK' };

    await run();

    // The ONLY write is clearing the tombstone — nothing is deleted.
    expect(h.callLog).toEqual(['FederatedActor.updateOne']);
    expect(h.federatedActor.updateOne).toHaveBeenCalledWith(
      { _id: actor._id },
      { $set: { suspended: false } },
    );
    expect(h.oxyDelete).not.toHaveBeenCalled();
    expect(h.federatedActor.deleteOne).not.toHaveBeenCalled();
  });

  it('unverified gate: a non-410 (404) actor is left fully intact — no deletes, no tombstone change', async () => {
    h.state.actors = [makeActor('X')];
    h.state.signed = { status: 404, ok: false, statusText: 'Not Found' };

    await run();

    expect(h.callLog).toEqual([]);
    expect(h.oxyDelete).not.toHaveBeenCalled();
    expect(h.federatedActor.updateOne).not.toHaveBeenCalled();
    expect(h.federatedActor.deleteOne).not.toHaveBeenCalled();
  });

  it('unverified gate: a transient re-verify error leaves the actor intact', async () => {
    h.state.actors = [makeActor('X')];
    h.state.signed = { status: 0, ok: false, statusText: '', throwErr: new Error('socket hang up') };

    await run();

    expect(h.callLog).toEqual([]);
    expect(h.oxyDelete).not.toHaveBeenCalled();
  });

  it('partial: a transient Oxy delete failure KEEPS the anchor (never orphans the Oxy user)', async () => {
    h.state.actors = [makeActor('X')];
    h.state.oxyOutcome = 'failed';

    await run();

    // Mention refs were removed and the Oxy delete was attempted...
    expect(h.oxyDelete).toHaveBeenCalledTimes(1);
    expect(h.callLog).toContain('oxy-delete');
    expect(h.callLog).toContain('FederatedFollow');
    // ...but the anchor is KEPT so a later run reconciles the still-live Oxy user.
    expect(h.callLog).not.toContain('FederatedActor.deleteOne');
    expect(h.federatedActor.deleteOne).not.toHaveBeenCalled();
  });

  it('partial: a permanent (skipped) Oxy delete rejection also keeps the anchor', async () => {
    h.state.actors = [makeActor('X')];
    h.state.oxyOutcome = 'skipped';

    await run();

    expect(h.oxyDelete).toHaveBeenCalledTimes(1);
    expect(h.federatedActor.deleteOne).not.toHaveBeenCalled();
  });

  it('--dry-run performs ZERO destructive work (no delete, no tombstone clear, no oxy-api call)', async () => {
    h.state.actors = [makeActor('X')];
    h.state.authoredPosts = [{ _id: new mongoose.Types.ObjectId() }];
    h.state.boostPosts = [{ _id: new mongoose.Types.ObjectId() }];

    await run(['--dry-run']);

    // No deleteMany / updateMany / deleteOne / updateOne ever executed.
    expect(h.callLog).toEqual([]);
    expect(h.oxyDelete).not.toHaveBeenCalled();
    expect(h.federatedActor.deleteOne).not.toHaveBeenCalled();
    expect(h.federatedActor.updateOne).not.toHaveBeenCalled();
    // It still COUNTS what it would delete (read-only), so the summary is accurate.
    expect(h.like.countDocuments).toHaveBeenCalled();
    expect(h.federatedFollow.countDocuments).toHaveBeenCalled();
  });

  it('purges an owner-less legacy row: uri-keyed refs + anchor, with no Oxy identity call', async () => {
    const actor = makeActor();
    actor.oxyUserId = undefined;
    h.state.actors = [actor];

    await run();

    // No owner id → no oxyUserId-keyed identity delete, but the uri-keyed follow
    // edges and the anchor are still removed.
    expect(h.oxyDelete).not.toHaveBeenCalled();
    expect(h.callLog).toContain('FederatedFollow');
    expect(h.callLog[h.callLog.length - 1]).toBe('FederatedActor.deleteOne');
  });
});
