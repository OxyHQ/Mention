import mongoose from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Offline, model-level test for the one-shot federated @mention repair.
 *
 * `Post.countDocuments` / `Post.find` / `Post.bulkWrite` are mocked over a small
 * in-memory store, and `signedFetch` is mocked per source URL — so the REAL
 * selection filter, paging, mention resolution, placeholder rewrite, body
 * re-derivation and write shape all run WITHOUT MongoDB or a network. That
 * mirrors the convention from `backfillFederatedBoostCounts.test.ts` /
 * `normalizeFederatedText.test.ts` (the repo has no `mongodb-memory-server` and
 * globally mocks mongoose).
 *
 * The `Post.find` / `countDocuments` mocks evaluate the script's ACTUAL filter
 * against the store rather than returning everything. That is load-bearing: the
 * idempotency guarantee is that a repaired post leaves the candidate set, and a
 * mock that ignored the filter could not tell that apart from a script that
 * re-repairs forever.
 *
 * `actor.service` is mocked purely so the test can ASSERT it is never called —
 * the repair must resolve lookup-only and can never mint a ghost `FederatedActor`.
 */

/** A stored content variant, in the shape the script reads and writes back. */
interface StoredVariant {
  source: string;
  text: string;
  tag?: string;
}

/** A stored `adminscriptcursors` row — where one shard scope got to. */
interface StoredCursor {
  script: string;
  scope: string;
  cursor: string;
  scanned: number;
  completedAt: Date | null;
}

/** A stored `repairfetchfailures` row — why one post's re-fetch failed. */
interface StoredFailure {
  script: string;
  postId: string;
  reason: string;
  status?: number;
  failedAt: Date;
}

/** A stored post row as `.lean()` hands it to the script. */
interface StoredPost {
  _id: mongoose.Types.ObjectId;
  type?: string;
  mentions?: string[];
  content?: {
    variants?: StoredVariant[];
    media?: { id: string; type: string }[];
  };
  federation?: { activityId?: string; actorUri?: string; url?: string };
}

/** The bulk op the script stages for one repaired post. */
interface BulkOp {
  updateOne: {
    filter: { _id: mongoose.Types.ObjectId };
    update: { $set: Record<string, unknown> };
  };
}

const mocks = vi.hoisted(() => {
  const store: {
    posts: StoredPost[];
    ops: BulkOp[];
    cursors: StoredCursor[];
    /** Every cursor value written, in order — the per-page persistence itself. */
    cursorWrites: { scope: string; cursor: string; scanned: number; completed: boolean }[];
    /** Set to make the next cursor write fail, like a database blip would. */
    cursorWriteError: Error | null;
    failureLog: StoredFailure[];
    /** Set to make the next failure-log write fail. */
    failureLogWriteError: Error | null;
  } = {
    posts: [],
    ops: [],
    cursors: [],
    cursorWrites: [],
    cursorWriteError: null,
    failureLog: [],
    failureLogWriteError: null,
  };

  /**
   * Read every value a dotted filter key reaches, fanning out through arrays the
   * way Mongo's implicit array traversal does (`content.variants.text` yields one
   * value per variant). An absent path yields NO values, which is what `$exists`
   * and `$ne` are then evaluated against.
   */
  const fieldValues = (source: unknown, segments: readonly string[]): unknown[] => {
    if (source === null || source === undefined) return [];
    if (segments.length === 0) return [source];
    if (Array.isArray(source)) return source.flatMap((item) => fieldValues(item, segments));
    if (typeof source !== 'object') return [];
    return fieldValues((source as Record<string, unknown>)[segments[0]], segments.slice(1));
  };

  /** Evaluate ONE filter condition against the values its key reached. */
  const conditionMatches = (values: readonly unknown[], condition: unknown): boolean => {
    if (condition === null) return values.length === 0 || values.some((value) => value === null);
    if (condition === undefined || typeof condition !== 'object') {
      return values.some((value) => value === condition);
    }
    return Object.entries(condition as Record<string, unknown>).every(([operator, operand]) => {
      switch (operator) {
        case '$exists':
          return values.length > 0 === operand;
        case '$ne':
          return !values.some((value) => value === operand);
        case '$size':
          return values.some((value) => Array.isArray(value) && value.length === operand);
        case '$gt':
          return values.some((value) => String(value) > String(operand));
        case '$lte':
          return values.some((value) => String(value) <= String(operand));
        case '$regex':
          return values.some((value) => typeof value === 'string' && (operand as RegExp).test(value));
        default:
          // Vacuity floor: an operator this matcher cannot evaluate must blow the
          // test up, never silently select (or reject) every row.
          throw new Error(`test filter matcher: unsupported operator ${operator}`);
      }
    });
  };

  /**
   * Evaluate the script's REAL candidate filter against one row.
   *
   * Deliberately derived from the filter object `buildCandidateFilter` produces
   * — no rule is restated here — so removing or weakening a clause changes what
   * this mock selects, instead of being silently ignored.
   */
  const matches = (row: StoredPost, filter: Record<string, unknown>): boolean =>
    Object.entries(filter).every(([key, condition]) => {
      if (key === '$or') {
        return (condition as Record<string, unknown>[]).some((clause) => matches(row, clause));
      }
      return conditionMatches(fieldValues(row, key.split('.')), condition);
    });

  return {
    store,
    signedFetch: vi.fn(),
    findExistingActor: vi.fn(),
    getOrFetchActor: vi.fn(),
    postModel: {
      countDocuments: vi.fn(async (filter: Record<string, unknown>) =>
        store.posts.filter((row) => matches(row, filter)).length,
      ),
      find: vi.fn((filter: Record<string, unknown>) => {
        let limit = Number.MAX_SAFE_INTEGER;
        const chain = {
          sort: () => chain,
          limit: (value: number) => {
            limit = value;
            return chain;
          },
          lean: async () =>
            [...store.posts]
              .sort((a, b) => a._id.toString().localeCompare(b._id.toString()))
              .filter((row) => matches(row, filter))
              .slice(0, limit),
        };
        return chain;
      }),
      bulkWrite: vi.fn(async (ops: BulkOp[]) => {
        store.ops.push(...ops);
        for (const op of ops) {
          const target = store.posts.find((row) => row._id.equals(op.updateOne.filter._id));
          if (!target) continue;
          const set = op.updateOne.update.$set;
          if (Array.isArray(set.mentions)) target.mentions = set.mentions as string[];
          if (Array.isArray(set['content.variants'])) {
            target.content = { ...target.content, variants: set['content.variants'] as StoredVariant[] };
          }
        }
        return { modifiedCount: ops.length };
      }),
    },
    /**
     * A minimal `adminscriptcursors` collection, so the REAL cursor helper runs
     * against it rather than being stubbed out. Mocking the helper instead would
     * leave the wiring — which scope a run reads, when it writes, whether a dry
     * run writes at all — untested, and that wiring is the entire fix.
     */
    cursorModel: {
      findOne: vi.fn((filter: { script: string; scope: string }) => ({
        lean: async () =>
          store.cursors.find(
            (row) => row.script === filter.script && row.scope === filter.scope,
          ) ?? null,
      })),
      updateOne: vi.fn(async (
        filter: { script: string; scope: string },
        update: { $set: Omit<StoredCursor, 'script' | 'scope'> },
      ) => {
        if (store.cursorWriteError) throw store.cursorWriteError;
        store.cursorWrites.push({
          scope: filter.scope,
          cursor: update.$set.cursor,
          scanned: update.$set.scanned,
          completed: update.$set.completedAt !== null,
        });
        const existing = store.cursors.find(
          (row) => row.script === filter.script && row.scope === filter.scope,
        );
        if (existing) Object.assign(existing, update.$set);
        else store.cursors.push({ ...filter, ...update.$set });
        return { acknowledged: true };
      }),
      deleteOne: vi.fn(async (filter: { script: string; scope: string }) => {
        store.cursors = store.cursors.filter(
          (row) => !(row.script === filter.script && row.scope === filter.scope),
        );
        return { deletedCount: 1 };
      }),
    },
    /**
     * A minimal `repairfetchfailures` collection with the model's UPSERT
     * semantics, so the bound the collection relies on — one row per distinct
     * failing post, not one per failure — is actually exercised rather than
     * asserted about a mock that appends unconditionally.
     */
    failureModel: {
      bulkWrite: vi.fn(async (ops: {
        updateOne: {
          filter: { script: string; postId: string };
          update: { $set: Omit<StoredFailure, 'script' | 'postId'> };
          upsert?: boolean;
        };
      }[]) => {
        if (store.failureLogWriteError) throw store.failureLogWriteError;
        for (const op of ops) {
          const { filter, update, upsert } = op.updateOne;
          const existing = store.failureLog.find(
            (row) => row.script === filter.script && row.postId === filter.postId,
          );
          if (existing) Object.assign(existing, update.$set);
          // `upsert` is HONOURED rather than assumed: a mock that inserted
          // regardless could not tell an upsert from a plain update, which is
          // precisely the property the bounded collection depends on.
          else if (upsert) store.failureLog.push({ ...filter, ...update.$set });
        }
        return { upsertedCount: ops.length };
      }),
    },
  };
});

vi.mock('../../models/Post', () => ({ Post: mocks.postModel }));

vi.mock('../../models/AdminScriptCursor', () => ({ AdminScriptCursor: mocks.cursorModel }));

vi.mock('../../models/RepairFetchFailure', () => ({ RepairFetchFailure: mocks.failureModel }));

vi.mock('../../connectors/activitypub/helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../connectors/activitypub/helpers')>()),
  // Only the network call is stubbed; `runWithTimeout`, `extractApMedia`,
  // `extractApHashtags` et al. stay REAL so the re-derivation under test is the
  // one production runs.
  signedFetch: mocks.signedFetch,
}));

vi.mock('../../models/FederatedActor', () => ({
  default: { findOne: mocks.findExistingActor },
}));

vi.mock('../../connectors/activitypub/actor.service', () => ({
  actorService: { getOrFetchActor: mocks.getOrFetchActor },
}));

// Media materialization is network + S3; the body re-derivation under test never
// calls it, but it is imported at module load.
vi.mock('../../connectors/shared/federatedMedia', () => ({
  materializeFederatedMedia: vi.fn(async (media: unknown[], attachments: unknown[]) => ({
    media,
    attachments,
  })),
}));

import {
  assertRepairRunComplete,
  buildCandidateFilter,
  buildCursorScope,
  repairFederatedMentions,
  resolveSourceUrl,
  SCRIPT_NAME,
  type RepairFederatedMentionsSummary,
} from '../../scripts/repairFederatedMentions';
import { logger } from '../../utils/logger';

const { store, postModel } = mocks;

/** The `logger.warn` calls the run emitted, as `[message, context]` pairs. */
function warnCalls(): [string, Record<string, unknown>][] {
  return vi.mocked(logger.warn).mock.calls as [string, Record<string, unknown>][];
}

const oid = (suffix: string): mongoose.Types.ObjectId =>
  new mongoose.Types.ObjectId(`00000000000000000000000${suffix}`);

const MENTIONED_OXY_ID = 'oxy_indigoparadox';

/**
 * The real Mastodon SAME-INSTANCE shape, verbatim from the toot that surfaced
 * the bug: the `Mention` tag `name` is the BARE `@user` (no `@domain`, because
 * author and mentioned user share an instance) while the in-content anchor points
 * at the human profile URL.
 */
const SAME_INSTANCE_NOTE = {
  type: 'Note',
  id: 'https://mastodon.social/users/Gargron/statuses/117016521955489722',
  content:
    '<p><span class="h-card" translate="no"><a href="https://mastodon.social/@indigoparadox" class="u-url mention">@<span>indigoparadox</span></a></span> No, none of that.</p>',
  tag: [
    {
      type: 'Mention',
      href: 'https://mastodon.social/users/indigoparadox',
      name: '@indigoparadox',
    },
  ],
};

/** The body the OLD ingest stored: the anchor stripped to dead `@user` text. */
const DAMAGED_TEXT = '@indigoparadox No, none of that.';
/** What the repair must land on: the internal placeholder hydration renders. */
const REPAIRED_TEXT = `[mention:${MENTIONED_OXY_ID}] No, none of that.`;

/** The ActivityPub OBJECT ID — the URL that answers `application/activity+json`. */
const OBJECT_ID = SAME_INSTANCE_NOTE.id;
/** The HUMAN web page permalink — serves HTML on plenty of servers. */
const WEB_PAGE_URL = 'https://mastodon.social/@Gargron/117016521955489722';

/**
 * A damaged, repairable post (the primary fixture). Every fixture carries BOTH
 * `activityId` and `url` on purpose: preferring the web page is what made a
 * production dry run reject 40 of 50 fetches on content-type, so "both present"
 * is the case that has to keep choosing the object id.
 */
function damagedPost(id: string, activityId = OBJECT_ID): StoredPost {
  return {
    _id: oid(id),
    mentions: [],
    content: { variants: [{ source: 'author', tag: 'en', text: DAMAGED_TEXT }] },
    federation: {
      activityId,
      actorUri: 'https://mastodon.social/users/Gargron',
      url: WEB_PAGE_URL,
    },
  };
}

/** Build an AP JSON response the way an origin server would answer. */
function apResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/activity+json' },
  });
}

beforeEach(() => {
  store.posts = [];
  store.ops = [];
  store.cursors = [];
  store.cursorWrites = [];
  store.cursorWriteError = null;
  store.failureLog = [];
  store.failureLogWriteError = null;
  mocks.failureModel.bulkWrite.mockClear();
  postModel.countDocuments.mockClear();
  postModel.find.mockClear();
  postModel.bulkWrite.mockClear();
  mocks.cursorModel.findOne.mockClear();
  mocks.cursorModel.updateOne.mockClear();
  mocks.cursorModel.deleteOne.mockClear();
  mocks.signedFetch.mockReset();
  mocks.getOrFetchActor.mockReset();
  mocks.findExistingActor.mockReset();
  vi.mocked(logger.warn).mockClear();

  // The mentioned actor IS already stored — the only shape the lookup-only
  // resolver can resolve.
  mocks.findExistingActor.mockReturnValue({
    lean: async () => ({ oxyUserId: MENTIONED_OXY_ID }),
  });
  // A fresh `Response` per call — a WHATWG body can only be read once, so a
  // shared `mockResolvedValue` would make every post after the first fail.
  mocks.signedFetch.mockImplementation(async () => apResponse(SAME_INSTANCE_NOTE));
});

describe('buildCandidateFilter', () => {
  it('selects federated non-boost posts with no mentions and an @-shaped body', () => {
    const filter = buildCandidateFilter();

    expect(filter['federation.activityId']).toEqual({ $exists: true, $ne: null });
    expect(filter.type).toEqual({ $ne: 'boost' });
    expect(filter.$or).toEqual([
      { mentions: { $exists: false } },
      { mentions: null },
      { mentions: { $size: 0 } },
    ]);

    // One regex, both damage shapes: the bare `@user` a stripped Mastodon anchor
    // leaves, and the `/@user` inside the raw profile URL a plain-text-child
    // anchor degrades to.
    const { $regex } = filter['content.variants.text'] as { $regex: RegExp };
    expect($regex.test('@indigoparadox No, none of that.')).toBe(true);
    expect($regex.test('hey https://mastodon.social/@alice look')).toBe(true);
    expect($regex.test('no mentions here at all')).toBe(false);
    expect(filter['federation.actorUri']).toBeUndefined();
  });

  it('narrows to a single origin actor when one is supplied', () => {
    expect(buildCandidateFilter('https://mastodon.social/users/Gargron')['federation.actorUri']).toBe(
      'https://mastodon.social/users/Gargron',
    );
  });
});

describe('resolveSourceUrl', () => {
  it('prefers the ActivityPub object id over the human web page', () => {
    // `federation.url` is Mastodon's `/@user/<id>` permalink, which a great many
    // servers serve as HTML whatever the `Accept` header says. `activityId` IS
    // the AP object — the URL federation itself dereferences.
    expect(
      resolveSourceUrl({
        _id: oid('1'),
        federation: { activityId: OBJECT_ID, url: WEB_PAGE_URL },
      }),
    ).toEqual({ url: OBJECT_ID, kind: 'activityId' });
  });

  it('falls back to the web page url only when the object id is absent', () => {
    expect(resolveSourceUrl({ _id: oid('1'), federation: { url: WEB_PAGE_URL } })).toEqual({
      url: WEB_PAGE_URL,
      kind: 'url',
    });
  });

  it('returns null when the post carries neither', () => {
    expect(resolveSourceUrl({ _id: oid('1'), federation: {} })).toBeNull();
    expect(resolveSourceUrl({ _id: oid('1') })).toBeNull();
  });
});

describe('repairFederatedMentions', () => {
  it('dereferences the object id, never the human web page, when both are present', async () => {
    store.posts = [damagedPost('1')];

    const summary = await repairFederatedMentions({ noteTimeoutMs: 1_000 });

    expect(summary.repaired).toBe(1);
    expect(mocks.signedFetch).toHaveBeenCalledTimes(1);
    expect(mocks.signedFetch.mock.calls[0][0]).toBe(OBJECT_ID);
    // The regression that failed 40 of 50 posts in production.
    expect(mocks.signedFetch).not.toHaveBeenCalledWith(WEB_PAGE_URL, expect.anything());
  });

  it('re-links a same-instance mention the old ingest stripped to dead text', async () => {
    store.posts = [damagedPost('1')];

    const summary = await repairFederatedMentions({ noteTimeoutMs: 1_000 });

    expect(summary.candidates).toBe(1);
    expect(summary.repaired).toBe(1);
    expect(summary.written).toBe(1);
    expect(summary.unresolved).toBe(0);

    // Exactly one write, an explicit `$set` whitelist — never a document spread.
    expect(store.ops).toHaveLength(1);
    expect(store.ops[0].updateOne.filter._id.toString()).toBe(oid('1').toString());
    expect(Object.keys(store.ops[0].updateOne.update)).toEqual(['$set']);
    expect(Object.keys(store.ops[0].updateOne.update.$set).sort()).toEqual([
      'content.variants',
      'mentions',
    ]);

    // The body carries the internal placeholder and the allowlist matches it.
    expect(store.ops[0].updateOne.update.$set['content.variants']).toEqual([
      // The stored language tag and `source` survive — a mention repair must not
      // re-decide what language the body is in.
      { source: 'author', tag: 'en', text: REPAIRED_TEXT },
    ]);
    expect(store.ops[0].updateOne.update.$set.mentions).toEqual([MENTIONED_OXY_ID]);

    // Lookup-only: a bulk sweep must never fetch or MINT a federated actor.
    expect(mocks.getOrFetchActor).not.toHaveBeenCalled();
    expect(mocks.findExistingActor).toHaveBeenCalledWith(
      { uri: 'https://mastodon.social/users/indigoparadox' },
      { oxyUserId: 1 },
    );

    // `bulkWrite` is the only write path, and it is unordered.
    expect(postModel.bulkWrite).toHaveBeenCalledWith(expect.anything(), { ordered: false });
  });

  it('never selects a post whose mentions are already resolved', async () => {
    store.posts = [
      {
        _id: oid('2'),
        mentions: ['oxy_bob'],
        content: { variants: [{ source: 'author', text: '[mention:oxy_bob] hi @carol' }] },
        federation: { activityId: 'https://remote.example/notes/2', url: 'https://remote.example/notes/2' },
      },
    ];

    const summary = await repairFederatedMentions({ noteTimeoutMs: 1_000 });

    expect(summary.candidates).toBe(0);
    expect(summary.scanned).toBe(0);
    expect(mocks.signedFetch).not.toHaveBeenCalled();
    expect(postModel.bulkWrite).not.toHaveBeenCalled();
  });

  it('is idempotent — a second run over a repaired corpus updates nothing', async () => {
    store.posts = [damagedPost('1')];

    const first = await repairFederatedMentions({ noteTimeoutMs: 1_000 });
    expect(first.repaired).toBe(1);
    expect(store.posts[0].mentions).toEqual([MENTIONED_OXY_ID]);
    expect(store.posts[0].content?.variants?.[0].text).toBe(REPAIRED_TEXT);

    postModel.bulkWrite.mockClear();
    mocks.signedFetch.mockClear();
    store.ops = [];

    const second = await repairFederatedMentions({ noteTimeoutMs: 1_000 });

    // The repaired post has left the candidate set entirely: nothing scanned,
    // nothing re-fetched, nothing written.
    expect(second.candidates).toBe(0);
    expect(second.scanned).toBe(0);
    expect(second.repaired).toBe(0);
    expect(mocks.signedFetch).not.toHaveBeenCalled();
    expect(postModel.bulkWrite).not.toHaveBeenCalled();
  });

  it('skips a 410 Gone origin without aborting the run or deleting the post', async () => {
    const goneObjectId = 'https://dead.example/users/x/statuses/gone';
    store.posts = [damagedPost('1'), damagedPost('2', goneObjectId)];
    mocks.signedFetch.mockImplementation(async (url: string) =>
      url === goneObjectId ? new Response(null, { status: 410 }) : apResponse(SAME_INSTANCE_NOTE),
    );

    const summary = await repairFederatedMentions({ noteTimeoutMs: 1_000 });

    expect(summary.scanned).toBe(2);
    expect(summary.gone).toBe(1);
    // The healthy post in the SAME page is still repaired — one dead origin
    // never aborts the sweep.
    expect(summary.repaired).toBe(1);
    expect(store.ops).toHaveLength(1);
    expect(store.ops[0].updateOne.filter._id.toString()).toBe(oid('1').toString());
    // The gone post keeps its stored body — a removed upstream is never a reason
    // to blank or delete a local copy.
    expect(store.posts[1].content?.variants?.[0].text).toBe(DAMAGED_TEXT);
  });

  it('leaves a transiently unreachable origin for a later re-run', async () => {
    const deadObjectId = 'https://offline.example/users/x/statuses/1';
    store.posts = [damagedPost('1'), damagedPost('2', deadObjectId)];
    mocks.signedFetch.mockImplementation(async (url: string) => {
      if (url === deadObjectId) throw new Error('ECONNREFUSED');
      return apResponse(SAME_INSTANCE_NOTE);
    });

    const summary = await repairFederatedMentions({ noteTimeoutMs: 1_000 });

    expect(summary.fetchFailed).toBe(1);
    expect(summary.repaired).toBe(1);
    expect(store.ops).toHaveLength(1);
    // Still a candidate, so the next run picks it up again.
    expect(store.posts[1].mentions).toEqual([]);
  });

  it('does not churn a body that is already correct — it writes only the allowlist', async () => {
    // The `@` that made this post a candidate is an EMAIL ADDRESS, and the body
    // already carries the placeholder; only the `mentions` allowlist is missing.
    // The re-derived body therefore equals the stored one, so it must not be
    // rewritten (no `updatedAt` churn, no risk to the stored language tag).
    const note = {
      ...SAME_INSTANCE_NOTE,
      content: SAME_INSTANCE_NOTE.content.replace(
        'No, none of that.',
        'No, none of that. mail@example.com',
      ),
    };
    mocks.signedFetch.mockImplementation(async () => apResponse(note));

    const post = damagedPost('1');
    post.content = {
      variants: [{ source: 'author', tag: 'en', text: `${REPAIRED_TEXT} mail@example.com` }],
    };
    store.posts = [post];

    const summary = await repairFederatedMentions({ noteTimeoutMs: 1_000 });

    expect(summary.repaired).toBe(1);
    expect(store.ops).toHaveLength(1);
    expect(Object.keys(store.ops[0].updateOne.update.$set)).toEqual(['mentions']);
    expect(store.ops[0].updateOne.update.$set.mentions).toEqual([MENTIONED_OXY_ID]);
  });

  it('logs ONE structured warn naming the URL, the field it came from, and the cause', async () => {
    // The production dry run could not be diagnosed at all: the failure warn
    // carried only the error, so nothing said WHICH url was attempted or WHAT
    // the origin served. This is the regression test for that.
    store.posts = [damagedPost('1')];
    mocks.signedFetch.mockImplementation(async () => {
      throw new Error('ActivityPub response has unsupported content-type: text/html');
    });

    const summary = await repairFederatedMentions({ noteTimeoutMs: 1_000 });

    expect(summary.fetchFailed).toBe(1);

    const failures = warnCalls().filter(
      ([message]) => message === '[repairFederatedMentions] source re-fetch failed',
    );
    expect(failures).toHaveLength(1);
    expect(failures[0][1]).toEqual({
      source: OBJECT_ID,
      sourceKind: 'activityId',
      reason: 'transport',
      status: undefined,
      contentType: undefined,
      // The media type the transport observed, so the operator sees "HTML" and
      // not merely "not JSON".
      detail: 'ActivityPub response has unsupported content-type: text/html',
    });
  });

  it('surfaces the HTTP status and the served media type on a bad status', async () => {
    store.posts = [damagedPost('1')];
    mocks.signedFetch.mockImplementation(
      async () =>
        new Response('<html>rate limited</html>', {
          status: 429,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    );

    const summary = await repairFederatedMentions({ noteTimeoutMs: 1_000 });

    expect(summary.fetchFailedByReason).toEqual({
      timeout: 0,
      transport: 0,
      httpStatus: 1,
      nonObjectPayload: 0,
      malformedJson: 0,
    });
    const [, context] = warnCalls().find(
      ([message]) => message === '[repairFederatedMentions] source re-fetch failed',
    ) as [string, Record<string, unknown>];
    expect(context.status).toBe(429);
    // Parameters dropped — the family is what identifies the problem.
    expect(context.contentType).toBe('text/html');
  });

  it('returns the exact post and URL of each failure for in-process review', async () => {
    const deadObjectId = 'https://offline.example/users/x/statuses/1';
    store.posts = [damagedPost('1', deadObjectId)];
    mocks.signedFetch.mockImplementation(async () => {
      throw new Error('ECONNREFUSED');
    });

    const summary = await repairFederatedMentions({ noteTimeoutMs: 1_000 });

    // The log reduces a URL to its host and redacts a 24-hex ObjectId outright,
    // so the returned record is the only place carrying both in full.
    expect(summary.failures).toEqual([
      {
        id: oid('1').toString(),
        source: deadObjectId,
        sourceKind: 'activityId',
        reason: 'transport',
        status: undefined,
        contentType: undefined,
        detail: 'ECONNREFUSED',
      },
    ]);
  });

  it('classifies a JSON body that is not an object, and caps collected failures', async () => {
    store.posts = [damagedPost('1'), damagedPost('2', 'https://a.example/users/x/statuses/2')];
    mocks.signedFetch.mockImplementation(
      async () =>
        new Response('["not an object"]', {
          status: 200,
          headers: { 'content-type': 'application/activity+json' },
        }),
    );

    const summary = await repairFederatedMentions({ noteTimeoutMs: 1_000, failureSampleSize: 1 });

    expect(summary.fetchFailed).toBe(2);
    expect(summary.fetchFailedByReason.nonObjectPayload).toBe(2);
    // Counted in full, collected up to the cap.
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0].reason).toBe('nonObjectPayload');
    expect(summary.failures[0].contentType).toBe('application/activity+json');
  });

  it('counts a note whose mentions resolve to nobody as unresolved, writing nothing', async () => {
    store.posts = [damagedPost('1')];
    // No stored `FederatedActor` row for the mentioned account.
    mocks.findExistingActor.mockReturnValue({ lean: async () => null });

    const summary = await repairFederatedMentions({ noteTimeoutMs: 1_000 });

    expect(summary.unresolved).toBe(1);
    expect(summary.repaired).toBe(0);
    expect(postModel.bulkWrite).not.toHaveBeenCalled();
    expect(mocks.getOrFetchActor).not.toHaveBeenCalled();
  });

  it('writes NOTHING under dryRun, while reporting the plan and a before/after sample', async () => {
    store.posts = [damagedPost('1')];

    const summary = await repairFederatedMentions({ dryRun: true, noteTimeoutMs: 1_000 });

    expect(summary.dryRun).toBe(true);
    expect(summary.repaired).toBe(1);
    expect(summary.written).toBe(0);
    expect(postModel.bulkWrite).not.toHaveBeenCalled();
    // The stored document is untouched.
    expect(store.posts[0].mentions).toEqual([]);
    expect(store.posts[0].content?.variants?.[0].text).toBe(DAMAGED_TEXT);

    // The preview reports exactly what a real run would write, JSON-quoted so the
    // placeholder is visible.
    expect(summary.samples).toEqual([
      {
        id: oid('1').toString(),
        before: JSON.stringify(DAMAGED_TEXT),
        after: JSON.stringify(REPAIRED_TEXT),
        mentions: [MENTIONED_OXY_ID],
      },
    ]);
  });

  it('honours the scan limit and pages by an ascending _id cursor', async () => {
    store.posts = [damagedPost('1'), damagedPost('2'), damagedPost('3')];

    const summary = await repairFederatedMentions({ limit: 2, batchSize: 1, noteTimeoutMs: 1_000 });

    expect(summary.candidates).toBe(3);
    expect(summary.scanned).toBe(2);
    expect(summary.repaired).toBe(2);
    expect(store.ops.map((op) => op.updateOne.filter._id.toString())).toEqual([
      oid('1').toString(),
      oid('2').toString(),
    ]);
    expect(store.posts[2].mentions).toEqual([]);
  });
});

/**
 * The resume cursor, which is the difference between a killed sweep being
 * continued and being restarted.
 *
 * Restarting is not merely slower: the candidate filter only stops matching a
 * post once it is REPAIRED, so every `unresolved`, `gone` and `fetchFailed` post
 * keeps matching forever at the LOWEST ids. Measured in production on
 * 2026-08-01, a restart re-walked a 9,466-post stuck head for 51 repairs (0.5%)
 * — nine thousand requests to other people's servers that could not succeed.
 * Every assertion below is ultimately about that: `signedFetch` call counts are
 * requests to somebody else's server.
 *
 * The cursor is exercised through a mocked `AdminScriptCursor` COLLECTION rather
 * than a mocked helper, so the wiring under test — which scope a run reads, when
 * it writes, and whether a dry run writes at all — actually runs.
 */
describe('resume cursor', () => {
  /** An id with hex LETTERS in it, so case canonicalisation is observable. */
  const LETTERED_ID = '65fdc8c8c8c8c8c8c8c8c8c8';

  /** A stored cursor for `scope`, as a killed run would have left it. */
  function storedCursor(scope: string, cursor: string, scanned: number): StoredCursor {
    return { script: SCRIPT_NAME, scope, cursor, scanned, completedAt: null };
  }

  it('records the cursor after EVERY page, not once at the end', async () => {
    store.posts = [damagedPost('1'), damagedPost('2'), damagedPost('3')];

    const summary = await repairFederatedMentions({ batchSize: 1, noteTimeoutMs: 1_000 });

    // A run that dies never reaches its final summary, so a cursor written only
    // at the end could not survive the one case it exists for.
    expect(store.cursorWrites).toEqual([
      { scope: summary.cursorScope, cursor: oid('1').toString(), scanned: 1, completed: false },
      { scope: summary.cursorScope, cursor: oid('2').toString(), scanned: 2, completed: false },
      { scope: summary.cursorScope, cursor: oid('3').toString(), scanned: 3, completed: false },
      // The empty page that ends the sweep: the range is exhausted, so the scope
      // is stamped finished rather than merely paused.
      { scope: summary.cursorScope, cursor: oid('3').toString(), scanned: 3, completed: true },
    ]);
    expect(store.cursors).toEqual([{
      script: SCRIPT_NAME,
      scope: summary.cursorScope,
      cursor: oid('3').toString(),
      scanned: 3,
      completedAt: expect.any(Date),
    }]);
  });

  it('leaves the scope unfinished when the run stopped on its limit', async () => {
    store.posts = [damagedPost('1'), damagedPost('2'), damagedPost('3')];

    await repairFederatedMentions({ limit: 2, batchSize: 1, noteTimeoutMs: 1_000 });

    // Stopping on a budget is not finishing, and a scope wrongly stamped
    // complete would read as "nothing left to do" forever.
    expect(store.cursorWrites.map((write) => write.completed)).toEqual([false, false]);
    expect(store.cursors[0]).toMatchObject({ cursor: oid('2').toString(), completedAt: null });
  });

  it('resumes past everything the previous run visited instead of restarting', async () => {
    store.posts = [damagedPost('1'), damagedPost('2'), damagedPost('3')];
    store.cursors = [storedCursor(buildCursorScope({}), oid('2').toString(), 2)];

    const summary = await repairFederatedMentions({ noteTimeoutMs: 1_000 });

    expect(summary.resumed).toBe(true);
    expect(summary.resumedFromScanned).toBe(2);
    expect(summary.scanned).toBe(1);
    // Counted within the resumed range, so the run reports the work it has LEFT.
    expect(summary.candidates).toBe(1);
    expect(store.ops.map((op) => op.updateOne.filter._id.toString())).toEqual([
      oid('3').toString(),
    ]);
    // The whole point: the stuck head is not re-fetched from its origin.
    expect(mocks.signedFetch).toHaveBeenCalledTimes(1);
    expect(store.posts[0].mentions).toEqual([]);
  });

  it('reads the cursor under a DRY RUN but never advances it', async () => {
    store.posts = [damagedPost('1'), damagedPost('2'), damagedPost('3')];
    store.cursors = [storedCursor(buildCursorScope({}), oid('1').toString(), 1)];

    const summary = await repairFederatedMentions({ dryRun: true, noteTimeoutMs: 1_000 });

    // Reading is what makes a preview show what the next LIVE run would do.
    expect(summary.resumed).toBe(true);
    expect(summary.scanned).toBe(2);
    // Writing would make that live run skip exactly the posts just previewed.
    expect(store.cursorWrites).toEqual([]);
    expect(store.cursors[0]).toMatchObject({ cursor: oid('1').toString(), scanned: 1 });
  });

  it('keeps each shard scope separate, so parallel shards never resume each other', async () => {
    store.posts = [damagedPost('1'), damagedPost('2'), damagedPost('3'), damagedPost('4')];
    // Shard A — ids up to 2 — has already finished its territory.
    store.cursors = [{
      ...storedCursor(buildCursorScope({ beforeId: oid('2') }), oid('2').toString(), 2),
      completedAt: new Date(),
    }];

    // Shard B — ids 3 and 4 — must be untouched by any of that.
    const summary = await repairFederatedMentions({
      afterId: oid('2').toString(),
      beforeId: oid('4').toString(),
      noteTimeoutMs: 1_000,
    });

    expect(summary.resumed).toBe(false);
    expect(summary.scanned).toBe(2);
    expect(store.ops.map((op) => op.updateOne.filter._id.toString())).toEqual([
      oid('3').toString(),
      oid('4').toString(),
    ]);
    expect(store.cursors).toHaveLength(2);
    expect(store.cursorWrites.every((write) => write.scope === summary.cursorScope)).toBe(true);
  });

  it('separates shards that differ only in their upper bound', async () => {
    store.posts = [damagedPost('1'), damagedPost('2'), damagedPost('3'), damagedPost('4')];
    // A narrow shard covering ids up to 2 has run to the end of its range.
    store.cursors = [storedCursor(
      buildCursorScope({ beforeId: oid('2') }),
      oid('2').toString(),
      2,
    )];

    // A WIDER shard from the same lower bound is a different territory. Sharing
    // a scope with the narrow one would make it skip ids 1 and 2 outright —
    // invisible in every counter, because it would report a clean resumed run.
    const summary = await repairFederatedMentions({
      beforeId: oid('4').toString(),
      noteTimeoutMs: 1_000,
    });

    expect(summary.resumed).toBe(false);
    expect(summary.scanned).toBe(4);
  });

  it('treats a differently-spelled bound as the SAME shard, not a second one', async () => {
    store.posts = [damagedPost('1')];

    const canonical = await repairFederatedMentions({
      afterId: LETTERED_ID,
      dryRun: true,
      noteTimeoutMs: 1_000,
    });
    const spelledDifferently = await repairFederatedMentions({
      afterId: `  ${LETTERED_ID.toUpperCase()}  `,
      dryRun: true,
      noteTimeoutMs: 1_000,
    });

    // Two spellings of one shard resolving to two scopes would leave each
    // re-walking the other's ground while both looked resumed.
    expect(spelledDifferently.cursorScope).toBe(canonical.cursorScope);
    // Vacuity floor: the scope really carries the canonicalised bound, rather
    // than both spellings collapsing to some constant.
    expect(canonical.cursorScope).toContain(LETTERED_ID);
  });

  it('refuses to run when the stored cursor lies outside the declared range', async () => {
    store.posts = [damagedPost('1'), damagedPost('2'), damagedPost('3')];
    const scope = buildCursorScope({ afterId: oid('1'), beforeId: oid('2') });
    store.cursors = [storedCursor(scope, oid('3').toString(), 3)];

    // Resuming from it would either skip a stretch of the corpus or re-walk a
    // neighbouring shard, and both are invisible in the counters.
    await expect(repairFederatedMentions({
      afterId: oid('1').toString(),
      beforeId: oid('2').toString(),
      noteTimeoutMs: 1_000,
    })).rejects.toThrow(/outside this run's declared _id range/);
    expect(mocks.signedFetch).not.toHaveBeenCalled();
  });

  it('starts the shard again, once, when the cursor is explicitly reset', async () => {
    store.posts = [damagedPost('1'), damagedPost('2'), damagedPost('3')];
    store.cursors = [storedCursor(buildCursorScope({}), oid('2').toString(), 2)];

    const summary = await repairFederatedMentions({ resetCursor: true, noteTimeoutMs: 1_000 });

    expect(summary.resumed).toBe(false);
    expect(summary.resumedFromScanned).toBe(0);
    expect(summary.scanned).toBe(3);
    expect(mocks.cursorModel.deleteOne).toHaveBeenCalledWith({
      script: SCRIPT_NAME,
      scope: summary.cursorScope,
    });
  });

  it('counts a cursor write that did not land, and fails the run for it', async () => {
    store.posts = [damagedPost('1')];
    store.cursorWriteError = new Error('connection reset by peer');

    const summary = await repairFederatedMentions({ noteTimeoutMs: 1_000 });

    // The sweep itself is unharmed — a database blip must not kill a six-hour
    // run that is repairing posts correctly.
    expect(summary.repaired).toBe(1);
    expect(summary.written).toBe(1);
    // But it is never swallowed: the damage lands on the NEXT run, which would
    // silently restart at the beginning.
    expect(summary.cursorWriteFailures).toBe(2);
    expect(() => assertRepairRunComplete(summary)).toThrow('cursorNotPersisted=2');
  });
});

/**
 * The per-post failure log, which is what makes retrying the transient tail
 * cheap enough to ever be worth doing.
 *
 * The candidate filter cannot tell a briefly-unreachable origin from a mentioned
 * actor we have never stored or an origin that answered 410. Measured on the
 * real corpus, that is 5,691 retryable posts inside 46,291 candidates — so
 * retrying THROUGH the filter costs ~40,600 requests to other people's servers
 * that cannot produce a repair, and the correct decision was not to. These rows
 * are what turn that into an indexed query instead.
 */
describe('re-fetch failure log', () => {
  /** An origin that is briefly unreachable — the retryable shape. */
  function rateLimited(): Response {
    return new Response('<html>rate limited</html>', {
      status: 429,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  it('records every failed post with the reason and status a retry selects on', async () => {
    store.posts = [damagedPost('1'), damagedPost('2')];
    mocks.signedFetch.mockImplementation(async () => rateLimited());

    const summary = await repairFederatedMentions({ noteTimeoutMs: 1_000 });

    expect(summary.fetchFailed).toBe(2);
    expect(store.failureLog).toEqual([
      {
        script: SCRIPT_NAME,
        postId: oid('1').toString(),
        reason: 'httpStatus',
        // 429 is worth coming back to; 403 would not be. Dropping the status
        // would make a polite retry indistinguishable from an impolite one.
        status: 429,
        failedAt: expect.any(Date),
      },
      {
        script: SCRIPT_NAME,
        postId: oid('2').toString(),
        reason: 'httpStatus',
        status: 429,
        failedAt: expect.any(Date),
      },
    ]);
  });

  it('records ALL failures, not just the bounded reading sample', async () => {
    store.posts = Array.from({ length: 5 }, (_, index) => damagedPost(String(index + 1)));
    mocks.signedFetch.mockImplementation(async () => rateLimited());

    const summary = await repairFederatedMentions({ failureSampleSize: 2, noteTimeoutMs: 1_000 });

    // A log capped at the sample size would be targeting two posts, not a tail.
    expect(summary.failures).toHaveLength(2);
    expect(store.failureLog).toHaveLength(5);
  });

  it('keeps one row per post however many runs re-fail it', async () => {
    store.posts = [damagedPost('1')];
    mocks.signedFetch.mockImplementation(async () => rateLimited());

    await repairFederatedMentions({ resetCursor: true, noteTimeoutMs: 1_000 });
    await repairFederatedMentions({ resetCursor: true, noteTimeoutMs: 1_000 });

    // Upserted, not appended: the collection is bounded by DISTINCT failing
    // posts, and the targeting query cannot return the same post twice.
    expect(store.failureLog).toHaveLength(1);
  });

  it('records nothing at all under a DRY RUN', async () => {
    store.posts = [damagedPost('1')];
    mocks.signedFetch.mockImplementation(async () => rateLimited());

    const summary = await repairFederatedMentions({ dryRun: true, noteTimeoutMs: 1_000 });

    expect(summary.fetchFailed).toBe(1);
    // A dry run promises to write NOTHING. Rows left behind by a preview are the
    // same broken promise as a cursor quietly advanced by one.
    expect(store.failureLog).toEqual([]);
    expect(mocks.failureModel.bulkWrite).not.toHaveBeenCalled();
  });

  it('records the page\'s failures BEFORE advancing the cursor past them', async () => {
    store.posts = [damagedPost('1'), damagedPost('2')];
    mocks.signedFetch.mockImplementation(async () => rateLimited());
    const order: string[] = [];
    mocks.failureModel.bulkWrite.mockImplementationOnce(async () => {
      order.push('failures');
      return { upsertedCount: 1 };
    });
    mocks.cursorModel.updateOne.mockImplementationOnce(async () => {
      order.push('cursor');
      return { acknowledged: true };
    });

    await repairFederatedMentions({ batchSize: 1, noteTimeoutMs: 1_000 });

    // If the cursor advanced first and the task were killed, a resumed run would
    // start PAST posts whose failures were never recorded — losing them from the
    // targeting set for good. This way the worst case is a re-walked page, which
    // the repair is idempotent against.
    expect(order).toEqual(['failures', 'cursor']);
  });

  it('counts failures it could not record, and fails the run for them', async () => {
    store.posts = [damagedPost('1'), damagedPost('2')];
    mocks.signedFetch.mockImplementation(async () => rateLimited());
    store.failureLogWriteError = new Error('connection reset by peer');

    const summary = await repairFederatedMentions({ noteTimeoutMs: 1_000 });

    expect(summary.failuresNotRecorded).toBe(2);
    // Costs this run nothing; costs the next one the only cheap route back to
    // those posts.
    expect(() => assertRepairRunComplete(summary)).toThrow('failuresNotRecorded=2');
  });
});

/**
 * Which counters reach the completion guard, and in which bucket. The guard's own
 * threshold arithmetic is covered by `adminRunTolerance.test.ts`; this pins the
 * WIRING, which is the part specific to this sweep and the part a future edit
 * could silently get wrong by dropping a strict counter into the tolerated bucket.
 */
describe('assertRepairRunComplete', () => {
  /** A clean summary of a 600-post run — the shape of the production dry run. */
  function summaryOf(overrides: Partial<RepairFederatedMentionsSummary> = {}): RepairFederatedMentionsSummary {
    const byReason = {
      timeout: 0,
      transport: 0,
      httpStatus: 0,
      nonObjectPayload: 0,
      malformedJson: 0,
      ...(overrides.fetchFailedByReason ?? {}),
    };
    return {
      dryRun: true,
      candidates: 164969,
      scanned: 600,
      repaired: 288,
      unchanged: 0,
      unresolved: 260,
      gone: 40,
      skippedNoSource: 0,
      skippedEmptyBody: 0,
      written: 0,
      lastScannedId: null,
      cursorScope: buildCursorScope({}),
      resumed: false,
      resumedFromScanned: 0,
      cursorWriteFailures: 0,
      failuresNotRecorded: 0,
      samples: [],
      failures: [],
      ...overrides,
      // Derived last so the per-reason merge above always wins, and the total
      // defaults to agreeing with it unless a case deliberately desyncs the two.
      fetchFailedByReason: byReason,
      fetchFailed:
        overrides.fetchFailed
        ?? Object.values(byReason).reduce((total, value) => total + value, 0),
    };
  }

  it('accepts the measured production run: 12 unreachable origins in 600 scanned (2%)', () => {
    expect(() =>
      assertRepairRunComplete(
        summaryOf({ fetchFailedByReason: { transport: 3, httpStatus: 9 } }),
      ),
    ).not.toThrow();
  });

  it('treats `gone` and `unresolved` as terminal outcomes, never as failures', () => {
    // 40 tombstoned origins and 260 mentions of actors we have never stored is
    // the lookup-only resolver working exactly as designed. Neither is handed to
    // the guard at all — a run of nothing but these must still pass.
    expect(() =>
      assertRepairRunComplete(summaryOf({ gone: 600, unresolved: 600, repaired: 0 })),
    ).not.toThrow();
  });

  it('fails once unreachable origins pass the stated ceiling', () => {
    // The pre-fix production run, which dereferenced the human web page: 80%.
    expect(() =>
      assertRepairRunComplete(summaryOf({ fetchFailedByReason: { httpStatus: 480 } })),
    ).toThrow(/remoteUnavailable=480 \(80\.00% of 600 scanned, over the 10\.00% allowed/);
  });

  it('fails on a SINGLE unparseable payload — our side is never a matter of rate', () => {
    expect(() =>
      assertRepairRunComplete(
        summaryOf({ fetchFailedByReason: { transport: 3, httpStatus: 9, malformedJson: 1 } }),
      ),
    ).toThrow('malformedPayload=1');

    expect(() =>
      assertRepairRunComplete(summaryOf({ fetchFailedByReason: { nonObjectPayload: 1 } })),
    ).toThrow('malformedPayload=1');
  });

  it('fails on a single candidate with no source URL — the filter guarantees one', () => {
    expect(() => assertRepairRunComplete(summaryOf({ skippedNoSource: 1 }))).toThrow(
      'skippedNoSource=1',
    );
  });

  it('fails on a single cursor write that did not persist', () => {
    // Costs this run nothing — which is exactly why it must fail here. The
    // damage lands on the NEXT run, which restarts at the beginning and
    // re-fetches the whole stuck head from other people's servers.
    expect(() => assertRepairRunComplete(summaryOf({ cursorWriteFailures: 1 }))).toThrow(
      'cursorNotPersisted=1',
    );
  });

  it('fails on a single failure it could not record for a later retry', () => {
    expect(() => assertRepairRunComplete(summaryOf({ failuresNotRecorded: 1 }))).toThrow(
      'failuresNotRecorded=1',
    );
  });

  it('fails on a single empty re-derive — the filter guarantees a stored body', () => {
    expect(() => assertRepairRunComplete(summaryOf({ skippedEmptyBody: 1 }))).toThrow(
      'skippedEmptyBody=1',
    );
  });

  it('fails STRICTLY on a failure that landed in no reason bucket', () => {
    // Vacuity guard: a future path incrementing the total without classifying it
    // must surface here, not vanish into a bucket it was never measured against.
    expect(() =>
      assertRepairRunComplete(
        summaryOf({ fetchFailed: 20, fetchFailedByReason: { httpStatus: 9 } }),
      ),
    ).toThrow('unclassifiedFetchFailure=11');
  });
});
