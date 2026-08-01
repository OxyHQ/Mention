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
  const store: { posts: StoredPost[]; ops: BulkOp[] } = { posts: [], ops: [] };

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
  };
});

vi.mock('../../models/Post', () => ({ Post: mocks.postModel }));

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
  buildCandidateFilter,
  repairFederatedMentions,
  resolveSourceUrl,
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
  postModel.countDocuments.mockClear();
  postModel.find.mockClear();
  postModel.bulkWrite.mockClear();
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
