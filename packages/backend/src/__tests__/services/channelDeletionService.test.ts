import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `ChannelDeletionService` destroys user data, so these tests are written against
 * a tiny in-memory Mongo rather than against call assertions alone: "the boost row
 * is deleted and the quote row survives with its pointer cleared" is a statement
 * about the END STATE, and a test that only checks which filters were passed
 * cannot tell a correct filter from one that matches nothing.
 *
 * Every model is mocked per-file, never from `setup.ts` — importing a real
 * Mongoose model here registers a schema that hangs unrelated suites.
 *
 * The fake collection throws on any operator it does not implement, which is the
 * vacuity floor: a filter shape nobody anticipated fails loudly instead of
 * silently matching nothing and making every assertion below pass.
 */

const { db, oid, moduleFor, FakeId } = vi.hoisted(() => {
  /**
   * Stands in for `mongoose.Types.ObjectId`, so a filter built in the ObjectId
   * spelling (`Like.postId`) and one built in the string spelling
   * (`Article.postId`) are genuinely different values that must both still match
   * the stored document — exactly what `idForm` in the binding table decides.
   */
  class FakeId {
    constructor(private readonly value: string) {}
    toString(): string {
      return this.value;
    }
    toJSON(): string {
      return this.value;
    }
  }

  type Doc = Record<string, unknown>;

  const normalize = (value: unknown): unknown =>
    value instanceof FakeId ? value.toString() : value;

  const isOperatorObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && !(value instanceof FakeId)
    && Object.keys(value).length > 0
    && Object.keys(value).every((key) => key.startsWith('$'));

  /** Dotted read, descending into an array of subdocuments (`repliers.oxyUserId`). */
  function valueAtPath(doc: unknown, path: string): unknown {
    return path.split('.').reduce<unknown>((current, key) => {
      if (current === undefined || current === null) return undefined;
      if (Array.isArray(current)) {
        const collected = current
          .map((element) =>
            typeof element === 'object' && element !== null
              ? (element as Doc)[key]
              : undefined,
          )
          .filter((value) => value !== undefined);
        return collected.length > 0 ? collected : undefined;
      }
      return (current as Doc)[key];
    }, doc);
  }

  /** Mongo equality: an array field matches when any element equals the operand. */
  function containsOrEquals(actual: unknown, expected: unknown): boolean {
    if (Array.isArray(actual)) {
      return actual.some((element) => normalize(element) === normalize(expected));
    }
    return normalize(actual) === normalize(expected);
  }

  function matchField(actual: unknown, condition: unknown): boolean {
    if (!isOperatorObject(condition)) return containsOrEquals(actual, condition);

    return Object.entries(condition).every(([operator, operand]) => {
      switch (operator) {
        case '$in':
          return (operand as unknown[]).some((value) => containsOrEquals(actual, value));
        case '$nin':
          return !(operand as unknown[]).some((value) => containsOrEquals(actual, value));
        case '$ne':
          return !containsOrEquals(actual, operand);
        case '$gt':
          return typeof actual === 'number' && actual > (operand as number);
        case '$exists':
          return (actual !== undefined) === operand;
        case '$elemMatch':
          return (
            Array.isArray(actual)
            && actual.some((element) => matchesFilter(element as Doc, operand as Doc))
          );
        default:
          throw new Error(`fake collection: unsupported query operator "${operator}"`);
      }
    });
  }

  function matchesFilter(doc: Doc, filter: Doc): boolean {
    return Object.entries(filter).every(([key, condition]) => {
      if (key === '$or') return (condition as Doc[]).some((sub) => matchesFilter(doc, sub));
      if (key === '$and') return (condition as Doc[]).every((sub) => matchesFilter(doc, sub));
      if (key.startsWith('$')) {
        throw new Error(`fake collection: unsupported top-level operator "${key}"`);
      }
      return matchField(valueAtPath(doc, key), condition);
    });
  }

  /** Walk to the parent object of a dotted path, without creating anything. */
  function parentOf(doc: Doc, path: string): { parent: Doc | undefined; key: string } {
    const segments = path.split('.');
    const key = segments[segments.length - 1];
    let current: unknown = doc;
    for (const segment of segments.slice(0, -1)) {
      if (typeof current !== 'object' || current === null) return { parent: undefined, key };
      current = (current as Doc)[segment];
    }
    if (typeof current !== 'object' || current === null) return { parent: undefined, key };
    return { parent: current as Doc, key };
  }

  function applyUpdate(doc: Doc, update: Doc): boolean {
    let modified = false;
    for (const [operator, spec] of Object.entries(update)) {
      for (const [path, operand] of Object.entries(spec as Doc)) {
        const { parent, key } = parentOf(doc, path);
        if (!parent) continue;
        switch (operator) {
          case '$unset':
            if (parent[key] !== undefined) {
              delete parent[key];
              modified = true;
            }
            break;
          case '$pull': {
            const array = parent[key];
            if (!Array.isArray(array)) break;
            const kept = array.filter((element) =>
              isOperatorObject(operand)
                ? !matchField(element, operand)
                : typeof operand === 'object' && operand !== null && !(operand instanceof FakeId)
                  ? !matchesFilter(element as Doc, operand as Doc)
                  : !containsOrEquals(element, operand),
            );
            if (kept.length !== array.length) {
              parent[key] = kept;
              modified = true;
            }
            break;
          }
          case '$inc':
            if (typeof parent[key] === 'number') {
              parent[key] = (parent[key] as number) + (operand as number);
              modified = true;
            }
            break;
          default:
            throw new Error(`fake collection: unsupported update operator "${operator}"`);
        }
      }
    }
    return modified;
  }

  /**
   * A Mongoose call site may `await` the query or call `.exec()` on it, and both
   * spellings are live here: this service awaits, while the delegated legs in
   * `PostDeletionCascade` call `.exec()`. A thenable that is missing `exec` fails
   * with `deleteMany(...).exec is not a function` rather than with anything about
   * the assertion, so the fake answers to both.
   */
  type Queryable<T> = Promise<T> & { exec: () => Promise<T> };
  function asQuery<T>(value: T): Queryable<T> {
    const settled = Promise.resolve(value);
    return Object.assign(settled, { exec: () => settled });
  }

  class FakeCollection {
    docs: Doc[] = [];

    readonly countDocuments = vi.fn((filter: Doc = {}): Queryable<number> =>
      asQuery(this.docs.filter((doc) => matchesFilter(doc, filter)).length),
    );

    readonly deleteMany = vi.fn((filter: Doc = {}): Queryable<{ deletedCount: number }> => {
      const remaining = this.docs.filter((doc) => !matchesFilter(doc, filter));
      const deletedCount = this.docs.length - remaining.length;
      this.docs = remaining;
      return asQuery({ deletedCount });
    });

    readonly updateMany = vi.fn((filter: Doc, update: Doc): Queryable<{ modifiedCount: number }> => {
      let modifiedCount = 0;
      for (const doc of this.docs) {
        if (matchesFilter(doc, filter) && applyUpdate(doc, update)) modifiedCount += 1;
      }
      return asQuery({ modifiedCount });
    });

    readonly updateOne = vi.fn((filter: Doc, update: Doc): Queryable<{ modifiedCount: number }> => {
      const target = this.docs.find((doc) => matchesFilter(doc, filter));
      if (!target) return asQuery({ modifiedCount: 0 });
      return asQuery({ modifiedCount: applyUpdate(target, update) ? 1 : 0 });
    });

    readonly find = vi.fn((filter: Doc = {}) => ({
      lean: async (): Promise<Doc[]> => this.docs.filter((doc) => matchesFilter(doc, filter)),
    }));
  }

  const collections = new Map<string, FakeCollection>();
  const collection = (name: string): FakeCollection => {
    const existing = collections.get(name);
    if (existing) return existing;
    const created = new FakeCollection();
    collections.set(name, created);
    return created;
  };

  const db = {
    collection,
    /** Every write method on every collection, for order and read-only assertions. */
    writeMocks(): ReturnType<typeof vi.fn>[] {
      return [...collections.values()].flatMap((c) => [c.deleteMany, c.updateMany, c.updateOne]);
    },
    reset(): void {
      for (const c of collections.values()) {
        c.docs = [];
        c.countDocuments.mockClear();
        c.deleteMany.mockClear();
        c.updateMany.mockClear();
        c.updateOne.mockClear();
        c.find.mockClear();
      }
    },
    seed(name: string, docs: Doc[]): void {
      collection(name).docs = docs;
    },
    docs(name: string): Doc[] {
      return collection(name).docs;
    },
    snapshot(): string {
      return JSON.stringify(
        Object.fromEntries([...collections.entries()].map(([name, c]) => [name, c.docs])),
      );
    },
  };

  /** The export shape a mocked model module needs: both the named and default binding. */
  const moduleFor = (name: string, extra: Record<string, unknown> = {}) => ({
    [name]: collection(name),
    default: collection(name),
    ...extra,
  });

  return { db, oid: (value: string) => new FakeId(value), moduleFor, FakeId };
});

/**
 * `PostDeletionCascade` — the delegate the post-dependent phase now runs through —
 * builds its ObjectId-spelled filters with the real `mongoose`, which rejects
 * these readable fixture ids (`p1`, `b1`) as invalid and would silently produce an
 * EMPTY id list. That is not the code under test failing; it is the fixture's id
 * shape, and swapping every id for a 24-hex string to satisfy it would make every
 * assertion in this file unreadable. So `Types.ObjectId` becomes the same FakeId
 * the fixtures use, and validity is the one thing the stub decides differently.
 */
vi.mock('mongoose', () => {
  const stub = {
    Types: { ObjectId: FakeId },
    isValidObjectId: (value: unknown) => String(value ?? '').length > 0,
  };
  return { ...stub, default: stub };
});

vi.mock('../../models/Post', () => moduleFor('Post'));
vi.mock('../../models/Like', () => moduleFor('Like'));
vi.mock('../../models/Bookmark', () => moduleFor('Bookmark'));
vi.mock('../../models/PostRecentReplier', () => moduleFor('PostRecentReplier'));
vi.mock('../../models/Poll', () => moduleFor('Poll'));
vi.mock('../../models/Article', () => moduleFor('Article'));
vi.mock('../../models/Postgate', () => moduleFor('Postgate'));
vi.mock('../../models/Threadgate', () => moduleFor('Threadgate'));
vi.mock('../../models/Notification', () => moduleFor('Notification'));
vi.mock('../../models/EngagementOutbox', () => moduleFor('EngagementOutbox'));
vi.mock('../../models/FeedInteraction', () => moduleFor('FeedInteraction'));
vi.mock('../../models/RepairFetchFailure', () => moduleFor('RepairFetchFailure'));
vi.mock('../../models/ContentLabel', () => moduleFor('ContentLabel'));
vi.mock('../../models/ModerationEnforcement', () => moduleFor('ModerationEnforcement'));
vi.mock('../../models/Report.model', () =>
  moduleFor('Report', {
    ReportedType: {
      POST: 'post',
      USER: 'user',
      COMMENT: 'comment',
      MESSAGE: 'message',
      ROOM: 'room',
    },
  }),
);
vi.mock('../../models/ModerationOutbox', () => moduleFor('ModerationOutbox'));
vi.mock('../../models/FederationDeliveryQueue', () => moduleFor('FederationDeliveryQueue'));
vi.mock('../../models/Lane', () => moduleFor('Lane'));
vi.mock('../../models/LaneMute', () => moduleFor('LaneMute'));
vi.mock('../../models/UserSettings', () => moduleFor('UserSettings'));
vi.mock('../../models/ActorKeyPair', () => moduleFor('ActorKeyPair'));
vi.mock('../../models/FederatedFollow', () => moduleFor('FederatedFollow'));
vi.mock('../../models/AuthorFollowerSnapshot', () => moduleFor('AuthorFollowerSnapshot'));
vi.mock('../../models/MentionSignedRecord', () => moduleFor('MentionSignedRecord'));
vi.mock('../../models/MentionRepoHead', () => moduleFor('MentionRepoHead'));
vi.mock('../../models/MentionUserNode', () => moduleFor('MentionUserNode'));
vi.mock('../../models/MentionNodeIngestWitness', () => moduleFor('MentionNodeIngestWitness'));
vi.mock('../../models/UserBehavior', () => moduleFor('UserBehavior'));
vi.mock('../../models/UserFeedPreference', () => moduleFor('UserFeedPreference'));
vi.mock('../../models/Mute', () => moduleFor('Mute'));
vi.mock('../../models/MuteWord', () => moduleFor('MuteWord'));
vi.mock('../../models/PostSubscription', () => moduleFor('PostSubscription'));
vi.mock('../../models/EntityFollow', () => moduleFor('EntityFollow'));
vi.mock('../../models/FeedLike', () => moduleFor('FeedLike'));
vi.mock('../../models/FeedReview', () => moduleFor('FeedReview'));
vi.mock('../../models/FeedGenerator', () => moduleFor('FeedGenerator'));
vi.mock('../../models/Labeler', () => moduleFor('Labeler'));
vi.mock('../../models/Poke', () => moduleFor('Poke'));
vi.mock('../../models/PushToken', () => moduleFor('PushToken'));
vi.mock('../../models/AccountList', () => moduleFor('AccountList'));
vi.mock('../../models/CustomFeed', () => moduleFor('CustomFeed'));
vi.mock('../../models/StarterPack', () => moduleFor('StarterPack'));
vi.mock('../../models/EndorsementOutbox', () => moduleFor('EndorsementOutbox'));
vi.mock('../../models/Trending', () => moduleFor('Trending'));
vi.mock('../../models/FederatedActor', () => moduleFor('FederatedActor'));

const { assertPostsSafeToDelete, collectPostCascadeResidue } = vi.hoisted(() => ({
  assertPostsSafeToDelete: vi.fn(async (..._args: unknown[]): Promise<void> => undefined),
  collectPostCascadeResidue: vi.fn(async (): Promise<string[]> => []),
}));
vi.mock('../../scripts/lib/adminDeletionPreflight', () => ({
  assertPostsSafeToDelete,
  collectPostCascadeResidue,
}));

const { federateDelete, deliverToFollowers, getUserById } = vi.hoisted(() => ({
  federateDelete: vi.fn(async () => undefined),
  deliverToFollowers: vi.fn(async () => undefined),
  getUserById: vi.fn(async () => ({ username: 'thechannel' })),
}));
vi.mock('../../connectors/activitypub/follow.service', () => ({
  followService: { federateDelete },
}));
vi.mock('../../connectors/activitypub/delivery.service', () => ({
  deliveryService: { deliverToFollowers },
}));
vi.mock('../../connectors/activitypub/constants', () => ({
  actorUrl: (username: string) => `https://mention.earth/ap/users/${username}`,
}));
vi.mock('@oxyhq/federation', () => ({
  AP_CONTEXT: ['https://www.w3.org/ns/activitystreams'],
}));
vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ getUserById }),
}));
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * The gate that decides whether this may run at all. Mocked rather than stubbed
 * through the identity cache, because the whole point of the assertions below is
 * which ANSWER the gate refuses, and routing that through
 * `resolveUserSummaries` would test the identity path instead.
 */
const { resolveAccountKind } = vi.hoisted(() => ({
  resolveAccountKind: vi.fn(async (): Promise<string | null> => 'channel'),
}));
vi.mock('../../services/publishAsAccount', () => ({ resolveAccountKind }));

/**
 * The delegate is SPIED, not replaced: these tests assert both that it is handed
 * the whole doomed set and that its real deletions land, and a stub would only
 * ever prove the first. Individual tests override the implementation where the
 * point is what happens WITHOUT it.
 */
vi.mock('../../services/PostDeletionCascade', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/PostDeletionCascade')>();
  return { ...actual, cascadePostReferences: vi.fn(actual.cascadePostReferences) };
});

import { CHANNEL_CASCADE } from '../../services/channelDeletion/channelCascadeManifest';
import { cascadePostReferences } from '../../services/PostDeletionCascade';
import {
  NotAChannelAccountError,
  deleteChannelContent,
  previewChannelDeletion,
} from '../../services/channelDeletion/ChannelDeletionService';

const cascadePostReferencesMock = vi.mocked(cascadePostReferences);

const CHANNEL = 'chan-1';
const WRITER = 'writer-1';
const SECOND_WRITER = 'writer-2';

/** Every key the executor must report, collapsed the way `steps` collapses them. */
const MANIFEST_KEYS = new Set(CHANNEL_CASCADE.map((step) => `${step.model}.${step.field}`));

function seedFixture(): void {
  db.reset();

  db.seed('Post', [
    // The channel's own posts.
    {
      _id: oid('p1'),
      oxyUserId: CHANNEL,
      authorship: [{ oxyUserId: CHANNEL, role: 'owner' }],
      type: 'text',
      visibility: 'public',
      status: 'published',
      // Never reattributed: the whole promise a channel makes.
      writtenByOxyUserId: WRITER,
      laneId: 'lane-1',
      stats: { likesCount: 1, boostsCount: 1 },
    },
    {
      // No writer id, so it separates the two doomed-post deletes: the
      // writer-carrying rows go in one step, this one in the next. A fixture
      // where every channel post looked alike could not tell those apart.
      _id: oid('p2'),
      oxyUserId: CHANNEL,
      authorship: [{ oxyUserId: CHANNEL, role: 'owner' }],
      type: 'boost',
      boostOf: 'ext-1',
      visibility: 'public',
      status: 'published',
      stats: { likesCount: 0, boostsCount: 0 },
    },
    {
      // Private, so it must NOT get a Delete(Tombstone) — only public+published
      // posts were ever advertised to a remote server.
      _id: oid('p3'),
      oxyUserId: CHANNEL,
      authorship: [{ oxyUserId: CHANNEL, role: 'owner' }],
      type: 'text',
      visibility: 'private',
      status: 'published',
      writtenByOxyUserId: SECOND_WRITER,
      // Quotes another DOOMED post. The scrub counts third-party rows only, so
      // this must not be swept up in it — it is deleted outright a phase later.
      quoteOf: 'p1',
      stats: { likesCount: 0, boostsCount: 0 },
    },

    {
      // The denormalized `oxyUserId` cache is missing: only the authorship owner
      // entry names the channel. The pre-save hook keeps the two in sync, but a
      // cascade is the wrong place to depend on that having held for every row
      // ever written.
      _id: oid('p4'),
      authorship: [{ oxyUserId: CHANNEL, role: 'owner' }],
      type: 'text',
      visibility: 'public',
      status: 'published',
      stats: { likesCount: 0, boostsCount: 0 },
    },

    // The load-bearing pair: another person's BOOST of a channel post, and
    // another person's QUOTE of the same post. A fixture carrying only one of
    // them cannot tell the two policies apart.
    {
      _id: oid('b1'),
      oxyUserId: 'other-1',
      authorship: [{ oxyUserId: 'other-1', role: 'owner' }],
      type: 'boost',
      boostOf: 'p1',
      visibility: 'public',
      status: 'published',
      stats: { likesCount: 0, boostsCount: 0 },
    },
    {
      // A boost OF that boost. `handleAnnounce` records an inbound Announce
      // against whatever local post the announced uri resolved to, and that post
      // can itself be a boost — so the doomed set has to be a closure, not one
      // hop. Left behind, this renders a placeholder with nothing behind it AND
      // makes the preflight refuse the run forever.
      _id: oid('b2'),
      oxyUserId: 'other-11',
      authorship: [{ oxyUserId: 'other-11', role: 'owner' }],
      type: 'boost',
      boostOf: 'b1',
      visibility: 'public',
      status: 'published',
      stats: { likesCount: 0, boostsCount: 0 },
    },
    {
      _id: oid('q1'),
      oxyUserId: 'other-2',
      type: 'text',
      quoteOf: 'p1',
      visibility: 'public',
      status: 'published',
      stats: { likesCount: 0, boostsCount: 0 },
    },

    // A reply into the set. A channel cannot be replied to, so this should not
    // exist — the cascade sweeps it anyway rather than holding the assumption.
    {
      _id: oid('r1'),
      oxyUserId: 'other-7',
      type: 'text',
      parentPostId: 'p1',
      threadId: 'p1',
      visibility: 'public',
      status: 'published',
      stats: { likesCount: 0, boostsCount: 0 },
    },

    // Surviving third-party rows the cascade scrubs rather than deletes.
    {
      _id: oid('m1'),
      oxyUserId: 'other-3',
      type: 'text',
      mentions: [CHANNEL, 'other-9'],
      visibility: 'public',
      status: 'published',
      stats: { likesCount: 0, boostsCount: 0 },
    },
    {
      _id: oid('stray-1'),
      oxyUserId: 'other-6',
      type: 'text',
      laneId: 'lane-1',
      visibility: 'public',
      status: 'published',
      stats: { likesCount: 0, boostsCount: 0 },
    },

    // Surviving posts whose denormalized counters must be repaired.
    {
      _id: oid('ext-1'),
      oxyUserId: 'other-4',
      type: 'text',
      visibility: 'public',
      status: 'published',
      stats: { likesCount: 0, boostsCount: 3 },
    },
    {
      _id: oid('liked-1'),
      oxyUserId: 'other-5',
      type: 'text',
      visibility: 'public',
      status: 'published',
      stats: { likesCount: 5, boostsCount: 0 },
    },
    {
      // Its counter already lags at zero — a denormalized count that predates the
      // like, or one an earlier repair already took. An unguarded decrement drives
      // it NEGATIVE and every reader downstream renders that.
      _id: oid('liked-2'),
      oxyUserId: 'other-12',
      type: 'text',
      visibility: 'public',
      status: 'published',
      stats: { likesCount: 0, boostsCount: 0 },
    },
  ]);

  db.seed('Like', [
    { _id: oid('like-1'), userId: CHANNEL, postId: oid('liked-1') },
    { _id: oid('like-2'), userId: 'other-8', postId: oid('p1') },
    { _id: oid('like-3'), userId: CHANNEL, postId: oid('liked-2') },
  ]);
  db.seed('Bookmark', [{ _id: oid('bm-1'), userId: 'other-8', postId: oid('p1') }]);
  db.seed('Poll', [
    // `Poll.postId` is `Schema.Types.Mixed`, so Mongo does no casting for it and
    // BOTH spellings really are stored in the wild.
    { _id: oid('poll-1'), postId: 'p1', createdBy: CHANNEL, question: 'a' },
    { _id: oid('poll-2'), postId: oid('p2'), createdBy: CHANNEL, question: 'b' },
  ]);
  db.seed('Notification', [
    { _id: oid('n-1'), recipientId: 'other-8', actorId: CHANNEL, entityType: 'post', entityId: oid('p1') },
    { _id: oid('n-2'), recipientId: 'other-9', actorId: 'other-9', entityType: 'profile', entityId: CHANNEL },
    { _id: oid('n-3'), recipientId: CHANNEL, actorId: 'other-9', entityType: 'profile', entityId: 'other-9' },
    {
      // Named by NOTHING except the doomed post — no channel id anywhere on it — so
      // only the delegated post-reference leg reaches it. That is what makes it a
      // discriminator: with the delegate stubbed out, it survives.
      _id: oid('n-4'),
      recipientId: 'other-8',
      actorId: 'other-8',
      entityType: 'reply',
      entityId: oid('p1'),
    },
  ]);
  db.seed('Threadgate', [
    // Somebody else's reply policy ON a doomed post. `Threadgate.createdBy` cannot
    // reach it, so the delegate is its only route out.
    { _id: oid('tg-1'), postId: 'p1', postUri: 'p1', createdBy: 'other-9' },
  ]);
  db.seed('Postgate', [
    { _id: oid('pg-1'), postId: 'p1', postUri: 'p1', createdBy: CHANNEL, detachedQuoteUris: [] },
    {
      _id: oid('pg-2'),
      postId: 'other',
      postUri: 'urn:other',
      createdBy: 'other-9',
      detachedQuoteUris: ['p1', 'keep-me'],
    },
  ]);
  db.seed('EngagementOutbox', [
    {
      _id: 'eo-1',
      status: 'pending',
      payload: { postId: 'p1', actorOxyUserId: 'other-8', postOwnerOxyUserId: CHANNEL },
    },
    {
      // Reachable ONLY through `payload.postId`: no field on it names the channel,
      // so a step keyed on the bare `postId` finds nothing and leaves it queued
      // against a post that will not exist when it drains.
      _id: 'eo-2',
      status: 'pending',
      payload: { postId: 'p1', actorOxyUserId: 'other-8' },
    },
    {
      // Already PROCESSED, and reachable only through `payload.postId`. The
      // delegate's disposition for this queue is cancel-pending, so this one must
      // SURVIVE: it can no longer act on anything, and the scan that would find it
      // is unindexed. A fixture with only pending rows cannot tell "cancels the
      // backlog" from "deletes the collection".
      _id: 'eo-3',
      status: 'processed',
      payload: { postId: 'p1', actorOxyUserId: 'other-8' },
    },
  ]);
  db.seed('Report', [
    { _id: oid('rep-1'), reportedType: 'post', reportedId: 'p1', reporter: 'other-9' },
    { _id: oid('rep-2'), reportedType: 'user', reportedId: 'other-9', reporter: CHANNEL },
    {
      // A Mention comment IS a post with a parent, so a POST-only filter would
      // leave every report about a reply behind.
      _id: oid('rep-3'),
      reportedType: 'comment',
      reportedId: 'p1',
      reporter: 'other-10',
    },
  ]);
  db.seed('ModerationOutbox', [
    { _id: 'mo-1', payload: { reportId: 'rep-1' } },
    { _id: 'mo-2', payload: { reportId: 'rep-2' } },
    { _id: 'mo-3', payload: { reportId: 'rep-3' } },
  ]);
  db.seed('FederationDeliveryQueue', [
    { _id: oid('dq-1'), senderOxyUserId: CHANNEL, targetInbox: 'https://remote/inbox' },
  ]);
  db.seed('Lane', [{ _id: oid('lane-1'), ownerId: CHANNEL }]);
  db.seed('LaneMute', [
    { _id: oid('lm-1'), viewerOxyUserId: 'other-9', laneId: 'lane-1', laneOwnerOxyUserId: CHANNEL },
  ]);
  db.seed('UserSettings', [
    { _id: oid('us-1'), oxyUserId: CHANNEL, channel: { signPosts: false } },
    { _id: oid('us-2'), oxyUserId: 'other-9', privacy: { restrictedUsers: [CHANNEL, 'keep-me'] } },
  ]);
  db.seed('UserBehavior', [
    {
      _id: oid('ub-1'),
      oxyUserId: 'other-9',
      preferredAuthors: [{ authorId: CHANNEL }, { authorId: 'keep-me' }],
      hiddenAuthors: [CHANNEL],
      mutedAuthors: [],
      blockedAuthors: [],
    },
  ]);
  db.seed('FederatedFollow', [
    {
      _id: oid('ff-1'),
      localUserId: CHANNEL,
      remoteActorUri: 'https://remote.example/users/a',
      direction: 'inbound',
      status: 'accepted',
    },
  ]);
  db.seed('Trending', [{ _id: oid('tr-1'), actorIds: [CHANNEL, 'other-9'] }]);
  db.seed('AccountList', [
    { _id: oid('al-1'), ownerOxyUserId: 'other-9', memberOxyUserIds: [CHANNEL, 'keep-me'] },
  ]);
  db.seed('MuteWord', [{ _id: oid('mw-1'), userId: CHANNEL, value: 'x' }]);
  db.seed('ContentLabel', [
    { _id: oid('cl-1'), targetType: 'post', targetId: 'p1', createdBy: 'other-9', labelSlug: 'x' },
    { _id: oid('cl-2'), targetType: 'user', targetId: CHANNEL, createdBy: 'other-9', labelSlug: 'x' },
    { _id: oid('cl-3'), targetType: 'user', targetId: 'other-9', createdBy: 'other-9', labelSlug: 'x' },
  ]);
  db.seed('PostRecentReplier', [
    {
      _id: oid('prr-1'),
      postId: 'someone-elses-post',
      repliers: [
        { oxyUserId: CHANNEL, repliedAt: 1 },
        { oxyUserId: 'keep-me', repliedAt: 2 },
      ],
    },
    {
      // The projection FOR a doomed post, naming nobody the account sweep knows —
      // another row only the delegate can reach.
      _id: oid('prr-2'),
      postId: 'p1',
      repliers: [{ oxyUserId: 'other-9', repliedAt: 1 }],
    },
  ]);
}

/** Every row a doomed post is reachable from ONLY through the delegated legs. */
const DELEGATE_ONLY_ROWS: ReadonlyArray<{ collection: string; id: string }> = [
  { collection: 'Like', id: 'like-2' },
  { collection: 'Bookmark', id: 'bm-1' },
  { collection: 'ContentLabel', id: 'cl-1' },
  { collection: 'Threadgate', id: 'tg-1' },
  { collection: 'PostRecentReplier', id: 'prr-2' },
  { collection: 'Notification', id: 'n-4' },
  { collection: 'EngagementOutbox', id: 'eo-2' },
];

/** The lowest recorded invocation order across a set of mocks, or Infinity. */
function firstCall(...mocks: Array<{ mock: { invocationCallOrder: number[] } }>): number {
  return Math.min(
    ...mocks.flatMap((mock) =>
      mock.mock.invocationCallOrder.length > 0 ? mock.mock.invocationCallOrder : [Number.POSITIVE_INFINITY],
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  seedFixture();
  getUserById.mockResolvedValue({ username: 'thechannel' });
  assertPostsSafeToDelete.mockResolvedValue(undefined);
  collectPostCascadeResidue.mockResolvedValue([]);
  resolveAccountKind.mockResolvedValue('channel');
});

describe('ChannelDeletionService', () => {
  it('accounts for every manifest entry exactly once, in exactly one of three ways', async () => {
    // The binding that stops the manifest and the executor drifting apart. A step
    // that stops being executed, delegated or retained loses its key from all three
    // sets, which is why `steps` is never pre-seeded from the manifest — doing that
    // would satisfy this assertion while deleting nothing.
    //
    // Delegated and retained steps are listed WITHOUT a count on purpose. A
    // fabricated `0` is indistinguishable from a step that silently stopped
    // running, which is the exact failure this assertion exists to catch, so
    // reporting one would defeat it from inside.
    expect(MANIFEST_KEYS.size, 'vacuity floor: the manifest must be substantial').toBeGreaterThanOrEqual(
      80,
    );

    const result = await deleteChannelContent(CHANNEL, { dryRun: false });
    const local = new Set(Object.keys(result.steps));
    const delegated = new Set(result.delegated);
    const retained = new Set(result.retained);

    // Disjointness first: without it the union can be satisfied by a key that is
    // reported twice, and a key dropped from one set would hide behind the other.
    const overlapping = [...MANIFEST_KEYS]
      .filter(
        (key) =>
          [local.has(key), delegated.has(key), retained.has(key)].filter(Boolean).length > 1,
      )
      .sort();
    expect(
      overlapping,
      `These keys are reported in more than one account:\n  ${overlapping.join('\n  ')}\n` +
        'Executed, delegated and retained are three different statements about one step; reporting a ' +
        'key twice makes a dropped account invisible.',
    ).toEqual([]);

    const reported = new Set([...local, ...delegated, ...retained]);
    const missing = [...MANIFEST_KEYS].filter((key) => !reported.has(key)).sort();
    const extra = [...reported].filter((key) => !MANIFEST_KEYS.has(key)).sort();

    expect(
      missing,
      `The cascade never accounted for these manifest steps:\n  ${missing.join('\n  ')}\n` +
        'Every entry in CHANNEL_CASCADE must be executed here, delegated to PostDeletionCascade, or ' +
        'retained on purpose — or rows pointing at a deleted channel survive with nothing to notice it.',
    ).toEqual([]);
    expect(
      extra,
      `The cascade reported steps the manifest does not name:\n  ${extra.join('\n  ')}\n` +
        'A write that no manifest entry describes is a deletion nobody reviewed.',
    ).toEqual([]);

    // Vacuity floors on the two new accounts: an empty `delegated` would satisfy
    // the union by leaving every key in `steps`, which is the duplication this
    // change removed.
    expect(result.delegated.length).toBeGreaterThanOrEqual(10);
    expect(result.retained).toEqual(['ModerationOutbox.reportId', 'Report.model.reportedId']);
  });

  it('reports a column classified under two scopes as locally executed, with the local count', async () => {
    // `Notification.entityId` and `ContentLabel.targetId` are each two references in
    // one column: a post id under one discriminator, a channel id under another. The
    // post half is the delegate's, the account half runs here, and the reported
    // count is the LOCAL work only — pinned so the precedence cannot drift silently
    // into reporting the delegate's rows as if this service had deleted them.
    const result = await deleteChannelContent(CHANNEL, { dryRun: false });

    expect(result.delegated).not.toContain('Notification.entityId');
    expect(result.delegated).not.toContain('ContentLabel.targetId');
    expect(result.steps['Notification.entityId'], 'the profile notification only').toBe(1);
    expect(result.steps['ContentLabel.targetId'], 'the label ON the channel only').toBe(1);
    // …and the post-scoped rows in the same collections are gone all the same.
    expect(db.docs('ContentLabel').map((doc) => String(doc._id))).toEqual(['cl-3']);
  });

  it('federates the deletion before deleting anything delivery reads', async () => {
    await deleteChannelContent(CHANNEL, { dryRun: false });

    // One Tombstone per PUBLIC + PUBLISHED channel post (p1, p2, p4) and none for
    // the private one, which no remote server was ever told about.
    expect(federateDelete).toHaveBeenCalledTimes(3);
    expect(deliverToFollowers).toHaveBeenCalledTimes(1);

    // The outbound queue drain is the ONE write the manifest requires BEFORE the
    // broadcast — a queued Create would otherwise race the Delete and republish a
    // post on the receiving instance. Every other write must come after.
    const queue = db.collection('FederationDeliveryQueue');
    const otherWrites = db.writeMocks().filter((mock) => mock !== queue.deleteMany);

    expect(firstCall(queue.deleteMany)).toBeLessThan(firstCall(deliverToFollowers));
    expect(firstCall(deliverToFollowers)).toBeLessThan(firstCall(...otherWrites));

    // The preflight is the gate, and it runs BEFORE the broadcast: a refusal is
    // permanent until an operator acts, so broadcasting first would leave remote
    // servers holding a Tombstone for posts that are still live here, on every
    // retry. It declares exactly what this cascade removes itself.
    expect(firstCall(assertPostsSafeToDelete)).toBeLessThan(firstCall(deliverToFollowers));
    const [, targets, acknowledgements] = assertPostsSafeToDelete.mock.calls[0];
    expect((targets as unknown[]).length, 'the whole doomed set is offered to the gate').toBe(6);
    expect(acknowledgements).toMatchObject({ allowDanglingReplyReferences: true });
    const { removedByCascade, keptByPolicy } = acknowledgements as {
      removedByCascade: string[];
      keptByPolicy: string[];
    };
    expect(removedByCascade).toContain('Like.postId');
    // The two claims are DIFFERENT claims and are made separately: one says the
    // rows are gone and is re-checked afterwards, the other says they stay on
    // purpose. Declaring a retained reference as removed would make the residue
    // check report it as a cascade leg that had stopped working, every run.
    expect(keptByPolicy).toContain('Report.reportedId(post)');
    expect(removedByCascade).not.toContain('Report.reportedId(post)');

    // …and the post rows go only after everything that pointed at them.
    const post = db.collection('Post');
    expect(firstCall(db.collection('Like').deleteMany)).toBeLessThan(firstCall(post.deleteMany));
    expect(firstCall(db.collection('Postgate').deleteMany)).toBeLessThan(firstCall(post.deleteMany));
    expect(firstCall(post.updateMany)).toBeLessThan(firstCall(post.deleteMany));
  });

  it('destroys a boost of a channel post and keeps a quote of it', async () => {
    const result = await deleteChannelContent(CHANNEL, { dryRun: false });

    const surviving = db.docs('Post').map((doc) => String(doc._id));
    expect(surviving, 'the boost renders entirely from an original that is gone').not.toContain('b1');
    expect(surviving, 'and so does a boost OF that boost — the set is a closure').not.toContain('b2');
    expect(surviving, "the quoter's own words are not the channel's to destroy").toContain('q1');

    const quote = db.docs('Post').find((doc) => String(doc._id) === 'q1');
    expect(quote?.quoteOf, 'the pointer is unset, not left dangling').toBeUndefined();

    expect(result.steps['Post.boostOf']).toBe(2);
    expect(result.steps['Post.quoteOf']).toBe(1);
    expect(result.preview.boostsByOthers).toBe(2);
    expect(result.preview.quotesByOthersKept).toBe(1);

    // The same distinction one level down: a reply keeps its text and loses its
    // "replying to" line; a third party's mention of the channel is pulled out of
    // a post that stays.
    const reply = db.docs('Post').find((doc) => String(doc._id) === 'r1');
    expect(reply?.parentPostId).toBeUndefined();
    expect(reply?.threadId).toBeUndefined();
    expect(db.docs('Post').find((doc) => String(doc._id) === 'm1')?.mentions).toEqual(['other-9']);
    expect(db.docs('Postgate').find((doc) => String(doc._id) === 'pg-2')?.detachedQuoteUris).toEqual([
      'keep-me',
    ]);

    // Counters on the posts that survive but lost an engagement record.
    expect(db.docs('Post').find((doc) => String(doc._id) === 'ext-1')?.stats).toEqual({
      likesCount: 0,
      boostsCount: 2,
    });
    expect(db.docs('Post').find((doc) => String(doc._id) === 'liked-1')?.stats).toEqual({
      likesCount: 4,
      boostsCount: 0,
    });
    expect(
      db.docs('Post').find((doc) => String(doc._id) === 'liked-2')?.stats,
      'a counter that already lags must not be driven negative',
    ).toEqual({ likesCount: 0, boostsCount: 0 });

    // The scrub counts THIRD-PARTY rows: a doomed post quoting another doomed post
    // is deleted outright, never counted as somebody else's writing being kept.
    expect(result.steps['Post.quoteOf']).toBe(1);
  });

  it('a dry run reads and reports without writing or federating', async () => {
    const before = db.snapshot();
    const result = await deleteChannelContent(CHANNEL, { dryRun: true });

    for (const write of db.writeMocks()) {
      expect(write, 'a dry run must not reach a single write').not.toHaveBeenCalled();
    }
    expect(federateDelete).not.toHaveBeenCalled();
    expect(deliverToFollowers).not.toHaveBeenCalled();
    expect(getUserById).not.toHaveBeenCalled();
    expect(db.snapshot()).toBe(before);

    expect(result.dryRun).toBe(true);
    expect(result.steps['Post.boostOf']).toBe(2);
    expect(result.steps['FederationDeliveryQueue.senderOxyUserId']).toBe(1);
    expect(
      Object.values(result.steps).filter((count) => count > 0).length,
      'a dry run that counts nothing is indistinguishable from a broken one',
    ).toBeGreaterThan(10);

    // The delegate DELETES, so a dry run cannot call it — and counting its rows
    // here instead would mean writing its queries a second time, which is the
    // duplication the delegation removed. The steps are still accounted for, by
    // name and without a fabricated count.
    expect(cascadePostReferencesMock).not.toHaveBeenCalled();
    expect(result.delegated).toContain('Like.postId');
    expect(result.steps).not.toHaveProperty('Like.postId');
  });

  it('is idempotent: a second run finds nothing and does not throw', async () => {
    const first = await deleteChannelContent(CHANNEL, { dryRun: false });
    expect(Object.values(first.steps).some((count) => count > 0)).toBe(true);

    const second = await deleteChannelContent(CHANNEL, { dryRun: false });

    const leftovers = Object.entries(second.steps).filter(([, count]) => count !== 0);
    expect(
      leftovers,
      `A re-run still affected rows:\n  ${leftovers.map(([key, count]) => `${key}=${count}`).join('\n  ')}\n` +
        'A retryable cascade must converge, or a BullMQ retry keeps mutating.',
    ).toEqual([]);
    expect(second.preview).toEqual({
      channelOxyUserId: CHANNEL,
      posts: 0,
      boostsByOthers: 0,
      replies: 0,
      quotesByOthersKept: 0,
      federatedFollowers: 0,
    });
    // Nothing left to address a Delete to, so no second broadcast.
    expect(deliverToFollowers).toHaveBeenCalledTimes(1);
  });

  it('never reattributes a channel post to the person who wrote it', async () => {
    const before = db.snapshot();
    expect(before, 'positive control: the writer ids are present before the run').toContain(WRITER);
    expect(before).toContain(SECOND_WRITER);

    const result = await deleteChannelContent(CHANNEL, { dryRun: false });

    // Both writer-carrying posts were DESTROYED, not handed to their writers…
    expect(result.steps['Post.writtenByOxyUserId']).toBe(2);
    expect(result.steps['Post.oxyUserId'], 'p2 and the authorship-only p4').toBe(2);

    for (const writer of [WRITER, SECOND_WRITER]) {
      expect(
        db.snapshot(),
        'With signPosts off, surfacing writtenByOxyUserId anywhere would retroactively publish who ' +
          'wrote what — the single promise a channel makes.',
      ).not.toContain(writer);
    }

    for (const call of db.collection('Post').updateMany.mock.calls) {
      expect(JSON.stringify(call[1]), 'no post is ever re-owned').not.toContain('oxyUserId');
    }
    for (const call of db.collection('Post').updateOne.mock.calls) {
      expect(JSON.stringify(call[1]), 'no post is ever re-owned').not.toContain('oxyUserId');
    }
  });

  it('runs every remaining step and then throws when one fails', async () => {
    const muteWords = db.collection('MuteWord');
    muteWords.deleteMany.mockRejectedValueOnce(new Error('mongo is having a day'));

    await expect(deleteChannelContent(CHANNEL, { dryRun: false })).rejects.toThrow(
      /MuteWord\.userId/,
    );

    // Steps before AND after the failure still ran, so a retry has as little left
    // to do as possible.
    expect(db.collection('Like').deleteMany).toHaveBeenCalled();
    expect(db.collection('FederatedActor').deleteMany).toHaveBeenCalled();
    expect(db.docs('Trending')[0].actorIds).toEqual(['other-9']);
  });

  it('scrubs a third-party row at its real nested path, never at the field name', async () => {
    // Four references whose Mongo path is not the name the manifest gives them.
    // A wrong path here does not error — it matches nothing, the step reports 0,
    // and the reference survives, which is the exact failure this cascade exists
    // to prevent. Each row belongs to somebody else and must SURVIVE, minus the
    // one entry naming the channel.
    const result = await deleteChannelContent(CHANNEL, { dryRun: false });

    expect(db.docs('UserSettings').find((doc) => doc.oxyUserId === 'other-9')).toMatchObject({
      privacy: { restrictedUsers: ['keep-me'] },
    });
    expect(db.docs('UserBehavior')[0]).toMatchObject({
      preferredAuthors: [{ authorId: 'keep-me' }],
      hiddenAuthors: [],
    });
    expect(db.docs('PostRecentReplier')[0]).toMatchObject({
      repliers: [{ oxyUserId: 'keep-me' }],
    });
    expect(db.docs('Trending')[0]).toMatchObject({ actorIds: ['other-9'] });
    expect(db.docs('AccountList')[0]).toMatchObject({ memberOxyUserIds: ['keep-me'] });

    expect(result.steps['UserSettings.restrictedUsers']).toBe(1);
    expect(result.steps['UserBehavior.authorId']).toBe(1);
    expect(result.steps['PostRecentReplier.oxyUserId']).toBe(1);

    // `payload`-nested outbox references, same hazard — including the row that
    // names the channel nowhere except inside `payload.postId`. The disposition is
    // the delegate's and it is cancel-pending, so the PROCESSED row stays: it can
    // no longer act on anything, and the query that would find the rest is a scan.
    expect(db.docs('EngagementOutbox').map((doc) => String(doc._id))).toEqual(['eo-3']);

    // A `Mixed` column stores a post id in either spelling and Mongo casts
    // neither, so a filter that builds only one of them leaves the other behind.
    expect(db.docs('Poll')).toHaveLength(0);
    const pollFilter = db
      .collection('Poll')
      .deleteMany.mock.calls.map(([filter]) => filter)
      .find((filter) => Array.isArray(filter.$or));
    const pollOperands = (
      ((pollFilter ?? {}).$or as Array<{ postId?: { $in: unknown[] } }>)[0].postId ?? { $in: [] }
    ).$in;
    expect(
      pollOperands.some((value) => typeof value === 'string'),
      'the string spelling must be in the filter Mongo receives',
    ).toBe(true);
    expect(
      pollOperands.some((value) => typeof value === 'object'),
      'and the ObjectId spelling too — a Mixed column casts neither',
    ).toBe(true);
  });

  it('sweeps the channel-scoped rows a step name does not mention', async () => {
    // `ContentLabel.targetId` is polymorphic on `targetType`. The post rows are the
    // delegate's; a label applied TO the channel has no delegate leg and no other
    // step to fall to, so a post-only reading leaves it pointing at an account that
    // no longer resolves. A stranger's unrelated label is untouched either way.
    const result = await deleteChannelContent(CHANNEL, { dryRun: false });

    expect(db.docs('ContentLabel').map((doc) => String(doc._id))).toEqual(['cl-3']);
    expect(result.steps['ContentLabel.targetId']).toBe(1);
  });

  it('keeps a report about a destroyed post, and its delivery job with it', async () => {
    // The end state, not a filter: a report and its `ModerationOutbox` job are
    // RETAINED. Deleting the report would strand an inbound CrowdSource decision —
    // `ModerationDecisionWorker` treats "case resolves to no local report" as
    // RETRYABLE, so the decision backs off and retries until it expires. That
    // reason does not depend on who deleted the post, so it cannot have one answer
    // on the live delete route and another here.
    await deleteChannelContent(CHANNEL, { dryRun: false });

    const surviving = db.docs('Report').map((doc) => String(doc._id));
    expect(
      surviving,
      'a report ABOUT a destroyed channel post survives the post',
    ).toContain('rep-1');
    expect(
      surviving,
      'and so does one filed as a COMMENT — a Mention comment is a post with a parent',
    ).toContain('rep-3');
    // The one report that does go is the one the channel FILED, which is a channel
    // reference rather than a post one and has its own manifest step.
    expect(surviving).not.toContain('rep-2');

    expect(
      db.docs('ModerationOutbox').map((doc) => String(doc._id)),
      'the delivery jobs are kept with the reports they name; nothing is orphaned',
    ).toEqual(['mo-1', 'mo-2', 'mo-3']);
    expect(db.collection('ModerationOutbox').deleteMany).not.toHaveBeenCalled();

    // No query for a retained reference may exist at all — `Report` is still
    // written to, but only by the step that removes reports the channel filed.
    for (const [filter] of db.collection('Report').deleteMany.mock.calls) {
      expect(
        Object.keys(filter),
        'the only Report delete is keyed on the reporter, never on the reported post',
      ).toEqual(['reporter']);
    }
  });

  it('a preflight refusal aborts before anything is federated or destroyed', async () => {
    assertPostsSafeToDelete.mockRejectedValueOnce(
      new Error('deletion preflight found references that are not covered by a cascade'),
    );

    await expect(deleteChannelContent(CHANNEL, { dryRun: false })).rejects.toThrow(
      /deletion preflight/,
    );

    expect(federateDelete).not.toHaveBeenCalled();
    expect(deliverToFollowers).not.toHaveBeenCalled();
    // The channel's own undelivered queue is the one thing already drained, which
    // is what makes the common blocker disappear before the gate is asked.
    expect(db.docs('FederationDeliveryQueue')).toHaveLength(0);
    // Nothing else was touched: every post is still here.
    expect(db.docs('Post')).toHaveLength(13);
    expect(db.docs('Like')).toHaveLength(3);
  });

  it('aborts before deleting anything when the channel username will not resolve', async () => {
    // The canonical Note ids a remote server matches a Tombstone against are minted
    // from the username, and it is read SERVER-SIDE from the authoritative
    // oxyUserId — never from a request. Without it the fediverse can never be told,
    // and once the posts are gone there is nothing left to address a later Delete
    // from, so the run stops here and is retried instead.
    getUserById.mockResolvedValueOnce({ username: '   ' });

    await expect(deleteChannelContent(CHANNEL, { dryRun: false })).rejects.toThrow(
      /no resolvable username/,
    );

    expect(federateDelete).not.toHaveBeenCalled();
    expect(deliverToFollowers).not.toHaveBeenCalled();
    expect(db.docs('Post')).toHaveLength(13);
    expect(db.docs('Like')).toHaveLength(3);
  });

  it('a counter repair that fails is logged, and does not lose the deletion', async () => {
    // The ids being repaired came from rows this run has already deleted, so a
    // retry computes an EMPTY repair set and can never make good on it. Failing
    // the job would lose the deletion's success without saving the counter.
    db.collection('Post').updateOne.mockRejectedValue(new Error('mongo is having a day'));

    const result = await deleteChannelContent(CHANNEL, { dryRun: false });

    expect(result.steps['Post.oxyUserId']).toBe(2);
    expect(db.docs('Post').find((doc) => String(doc._id) === 'ext-1')?.stats).toEqual({
      likesCount: 0,
      boostsCount: 3,
    });
  });

  it('hands the whole doomed set to PostDeletionCascade, once', async () => {
    await deleteChannelContent(CHANNEL, { dryRun: false });

    expect(cascadePostReferencesMock).toHaveBeenCalledTimes(1);
    const [handed] = cascadePostReferencesMock.mock.calls[0];
    expect(
      handed.map((row) => String(row._id)).sort(),
      'the channel\'s own posts AND the boosts of them — a partial set leaves references behind',
    ).toEqual(['b1', 'b2', 'p1', 'p2', 'p3', 'p4']);

    // Rows, not ids: the delegate also reaches a post's owned Poll and Article
    // through `content.pollId` / `content.article.articleId`, which an id list
    // cannot carry.
    expect(handed.every((row) => typeof row === 'object' && '_id' in row)).toBe(true);
  });

  it('issues none of the delegated queries itself', async () => {
    // The mutation-resistant half of the delegation: with the delegate stubbed to a
    // no-op, every row reachable ONLY through a delegated leg must SURVIVE. A
    // leftover local copy of any of those queries — the duplication this change
    // removed — shows up here as a row that disappeared anyway.
    cascadePostReferencesMock.mockResolvedValueOnce({ failedLegs: [] });

    await deleteChannelContent(CHANNEL, { dryRun: false });

    for (const { collection, id } of DELEGATE_ONLY_ROWS) {
      expect(
        db.docs(collection).map((doc) => String(doc._id)),
        `${collection}/${id} is reachable only through the delegate, so nothing here may delete it`,
      ).toContain(id);
    }

    // Positive control: the run really did happen, and the steps this service still
    // owns did their work.
    expect(db.docs('Post').map((doc) => String(doc._id))).not.toContain('p1');
    expect(db.docs('Lane')).toHaveLength(0);
  });

  it('a failed delegate leg makes the run throw, so a retry re-runs it', async () => {
    // The whole reason `cascadePostReferences` exists beside the never-throwing
    // entry point the live delete route calls: an administrative cascade runs inside
    // a job that CAN be retried, so a leg that failed has to reach the caller.
    cascadePostReferencesMock.mockResolvedValueOnce({ failedLegs: ['Like.postId'] });

    await expect(deleteChannelContent(CHANNEL, { dryRun: false })).rejects.toThrow(
      /PostDeletionCascade:Like\.postId/,
    );
  });

  it('previews without touching anything', async () => {
    const before = db.snapshot();
    const preview = await previewChannelDeletion(CHANNEL);

    expect(preview).toEqual({
      channelOxyUserId: CHANNEL,
      posts: 4,
      boostsByOthers: 2,
      // A channel cannot be replied to, so this is a finding rather than a number
      // to accept — the fixture carries one on purpose.
      replies: 1,
      quotesByOthersKept: 1,
      federatedFollowers: 1,
    });
    for (const write of db.writeMocks()) {
      expect(write).not.toHaveBeenCalled();
    }
    expect(db.snapshot()).toBe(before);
  });
});

/**
 * The gate that decides whether any of the above may run at all.
 *
 * TWO-SIDED ON PURPOSE. A suite that only ever feeds this a `channel` cannot tell
 * "refuses everything else" from "refuses nothing" — both pass — so the refusing
 * fixtures are the load-bearing ones and the accepting fixture is what stops the
 * gate being satisfied by a function that always throws.
 */
describe('ChannelDeletionService — the account-kind gate', () => {
  /** Both entry points, because the refusal has to hold for the read-only one too. */
  const entryPoints: ReadonlyArray<{ name: string; run: () => Promise<unknown> }> = [
    { name: 'deleteChannelContent', run: () => deleteChannelContent(CHANNEL, { dryRun: false }) },
    { name: 'previewChannelDeletion', run: () => previewChannelDeletion(CHANNEL) },
  ];

  /** Nothing was read, nothing was written, nothing was told to the fediverse. */
  function expectUntouched(before: string): void {
    expect(
      db.collection('Post').find,
      'the gate must run BEFORE any read of the post set, not after it',
    ).not.toHaveBeenCalled();
    for (const write of db.writeMocks()) {
      expect(write, 'a refusal must not reach a single write').not.toHaveBeenCalled();
    }
    expect(federateDelete).not.toHaveBeenCalled();
    expect(deliverToFollowers).not.toHaveBeenCalled();
    expect(getUserById).not.toHaveBeenCalled();
    expect(cascadePostReferencesMock).not.toHaveBeenCalled();
    expect(assertPostsSafeToDelete).not.toHaveBeenCalled();
    expect(db.snapshot()).toBe(before);
  }

  for (const { name, run } of entryPoints) {
    it(`${name} refuses a personal account, and destroys nothing`, async () => {
      // The case the gate exists for. `deleteChannelContent` took an oxyUserId on
      // trust; pointed at a human's account it destroys their posts irreversibly,
      // and "no route calls it yet" is the absence of an accident rather than a
      // defence against one.
      resolveAccountKind.mockResolvedValue('personal');
      const before = db.snapshot();

      await expect(run()).rejects.toThrow(NotAChannelAccountError);
      await expect(run()).rejects.toThrow(/resolved as personal, not a channel/);

      expectUntouched(before);
    });

    it(`${name} refuses an account whose kind will not resolve`, async () => {
      // `resolveAccountKind` is fail-soft to `null` BY DESIGN — the reply gate needs
      // an identity outage not to refuse every reply on the site — so the decision
      // belongs to each caller, and here it is no. Accepting `null` would make an
      // Oxy outage the condition under which this deletes anything it is pointed at.
      resolveAccountKind.mockResolvedValue(null);
      const before = db.snapshot();

      await expect(run()).rejects.toThrow(NotAChannelAccountError);
      // The message distinguishes the two causes because the operator response
      // differs: a wrong id must never be retried as-is, an outage should be.
      await expect(run()).rejects.toThrow(/could not be resolved/);

      expectUntouched(before);
    });

    it(`${name} refuses when the kind lookup itself fails`, async () => {
      // Belt and braces: the fail-soft contract lives in another module and could be
      // tightened there without anybody looking at this call site.
      resolveAccountKind.mockRejectedValue(new Error('oxy is having a day'));
      const before = db.snapshot();

      await expect(run()).rejects.toThrow(NotAChannelAccountError);
      await expect(run()).rejects.toThrow(/could not be resolved/);

      expectUntouched(before);
    });
  }

  it('proceeds for a channel — without this the gate could be refusing everything', async () => {
    resolveAccountKind.mockResolvedValue('channel');

    const result = await deleteChannelContent(CHANNEL, { dryRun: false });

    expect(resolveAccountKind).toHaveBeenCalledWith(CHANNEL);
    expect(result.preview.posts).toBe(4);
    expect(db.docs('Post').map((doc) => String(doc._id))).not.toContain('p1');
    expect(deliverToFollowers).toHaveBeenCalledTimes(1);
  });
});
