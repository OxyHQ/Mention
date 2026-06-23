import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * Concurrency coverage for {@link UserPreferenceService.recordInteraction}.
 *
 * Feed-impression telemetry fires many concurrent interactions for the SAME
 * user, so the load-modify-`.save()` on the `UserBehavior` document races on
 * Mongoose optimistic concurrency (`__v`) → a flood of `VersionError`. The
 * service now wraps the write in a bounded retry loop that RE-READS the freshest
 * document and RE-APPLIES the same mutation. These tests prove:
 *  1. a `VersionError` on `.save()` is retried (no throw) and the accumulators
 *     end up correct on the winning revision,
 *  2. the first-interaction insert race (`E11000` duplicate key) is retried the
 *     same way,
 *  3. retries are bounded — a persistent conflict eventually surfaces the error.
 *
 * The Post and UserBehavior models are mocked (no DB). `mongoose` itself is NOT
 * mocked, so the real `VersionError` / `MongoServerError` classes are used and
 * the service's `instanceof` checks exercise production code paths.
 */

interface AuthorPref {
  authorId: string;
  interactionCount: number;
  lastInteractionAt: Date;
  interactionTypes: { likes: number; boosts: number; comments: number; saves: number; shares: number };
  weight: number;
}

interface MockBehavior {
  oxyUserId: string;
  preferredAuthors: AuthorPref[];
  preferredTopics: Array<Record<string, unknown>>;
  preferredPostTypes: Record<string, number>;
  activeHours: number[];
  preferredLanguages: string[];
  hiddenAuthors: string[];
  mutedAuthors: string[];
  blockedAuthors: string[];
  hiddenTopics: string[];
  lastUpdated?: Date;
  markModified: () => void;
  save: () => Promise<void>;
}

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  findOne: vi.fn(),
  construct: vi.fn(),
}));

vi.mock('../../models/Post', () => ({
  Post: { findById: (id: string) => ({ lean: () => mocks.findById(id) }) },
}));
// The default export is BOTH a constructor (service does `new UserBehavior(...)`
// on a first interaction) and a holder of the static `findOne`.
vi.mock('../../models/UserBehavior', () => {
  function UserBehavior(this: unknown, doc: unknown) {
    return mocks.construct(doc);
  }
  UserBehavior.findOne = (filter: unknown) => mocks.findOne(filter);
  return { __esModule: true, default: UserBehavior };
});
vi.mock('../../models/Like', () => ({ __esModule: true, default: { find: vi.fn() } }));
vi.mock('../../models/Bookmark', () => ({ __esModule: true, default: { find: vi.fn() } }));

import { userPreferenceService } from '../../services/UserPreferenceService';

function makeBehavior(overrides: Partial<MockBehavior> = {}): MockBehavior {
  return {
    oxyUserId: 'viewer-1',
    preferredAuthors: [],
    preferredTopics: [],
    preferredPostTypes: { text: 0, image: 0, video: 0, poll: 0 },
    activeHours: [],
    preferredLanguages: [],
    hiddenAuthors: [],
    mutedAuthors: [],
    blockedAuthors: [],
    hiddenTopics: [],
    markModified: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeVersionError(): mongoose.Error.VersionError {
  // A value whose prototype IS VersionError.prototype, so the service's
  // `error instanceof mongoose.Error.VersionError` check is exercised against the
  // real class. The real constructor needs a fully-typed Document we don't have
  // in a unit test, so we build the instance via the prototype + a realistic
  // message instead of fabricating a fake Document.
  const err: mongoose.Error.VersionError = Object.create(mongoose.Error.VersionError.prototype);
  Object.defineProperty(err, 'message', {
    value: 'No matching document found for id "beh-1" version 1 modifiedPaths "preferredAuthors"',
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return err;
}

function makeDuplicateKeyError(): mongoose.mongo.MongoServerError {
  const err = new mongoose.mongo.MongoServerError({ message: 'E11000 duplicate key error' });
  err.code = 11000;
  return err;
}

const LIKE_POST = {
  _id: 'p1',
  oxyUserId: 'author-1',
  type: 'text',
  hashtags: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findById.mockResolvedValue(LIKE_POST);
});

describe('UserPreferenceService.recordInteraction — concurrent write retries', () => {
  it('retries on a VersionError and applies the mutation to the freshest revision (no throw)', async () => {
    // Attempt 1: a stale doc whose `.save()` loses the `__v` race.
    const stale = makeBehavior();
    stale.save = vi.fn().mockRejectedValueOnce(makeVersionError());
    // Attempt 2: the freshest revision (a concurrent like already landed for a
    // DIFFERENT author) — the retry must apply OUR like on top of it.
    const fresh = makeBehavior({
      preferredAuthors: [
        {
          authorId: 'author-2',
          interactionCount: 1,
          lastInteractionAt: new Date(),
          interactionTypes: { likes: 1, boosts: 0, comments: 0, saves: 0, shares: 0 },
          weight: 0.01,
        },
      ],
    });

    mocks.findOne.mockResolvedValueOnce(stale).mockResolvedValueOnce(fresh);

    await expect(
      userPreferenceService.recordInteraction('viewer-1', 'p1', 'like'),
    ).resolves.toBeUndefined();

    // Re-read happened on the retry, and the second attempt persisted.
    expect(mocks.findOne).toHaveBeenCalledTimes(2);
    expect(fresh.save).toHaveBeenCalledTimes(1);

    // The concurrent author survives AND our like is applied on top — accumulators correct.
    expect(fresh.preferredAuthors.find(a => a.authorId === 'author-2')).toBeDefined();
    const mine = fresh.preferredAuthors.find(a => a.authorId === 'author-1');
    expect(mine).toBeDefined();
    expect(mine?.interactionTypes.likes).toBe(1);
    expect(mine?.weight).toBeGreaterThan(0);
  });

  it('retries on a duplicate-key error from a racing first-interaction insert', async () => {
    // Attempt 1: no doc yet → service builds one via `new UserBehavior(...)`; its
    // `.save()` loses the unique-`oxyUserId` insert race (E11000).
    const inserted = makeBehavior();
    inserted.save = vi.fn().mockRejectedValueOnce(makeDuplicateKeyError());
    mocks.construct.mockReturnValueOnce(inserted);
    // Attempt 2: the racing insert's document now exists.
    const winner = makeBehavior();
    mocks.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);

    await expect(
      userPreferenceService.recordInteraction('viewer-1', 'p1', 'like'),
    ).resolves.toBeUndefined();

    expect(mocks.findOne).toHaveBeenCalledTimes(2);
    expect(winner.save).toHaveBeenCalledTimes(1);
    expect(winner.preferredAuthors.find(a => a.authorId === 'author-1')?.interactionTypes.likes).toBe(1);
  });

  it('does NOT retry on a non-conflict error (re-throws immediately)', async () => {
    const doc = makeBehavior();
    doc.save = vi.fn().mockRejectedValue(new Error('mongo offline'));
    mocks.findOne.mockResolvedValue(doc);

    await expect(
      userPreferenceService.recordInteraction('viewer-1', 'p1', 'like'),
    ).rejects.toThrow('mongo offline');

    // Read exactly once — no retry on a generic error.
    expect(mocks.findOne).toHaveBeenCalledTimes(1);
  });

  it('bounds retries — a persistent VersionError eventually surfaces', async () => {
    // Every attempt re-reads a fresh stale doc whose save always loses the race.
    mocks.findOne.mockImplementation(async () => {
      const d = makeBehavior();
      d.save = vi.fn().mockRejectedValue(makeVersionError());
      return d;
    });

    await expect(
      userPreferenceService.recordInteraction('viewer-1', 'p1', 'like'),
    ).rejects.toBeInstanceOf(mongoose.Error.VersionError);

    // 1 initial attempt + MAX_VERSION_CONFLICT_RETRIES (5) retries = 6 reads.
    expect(mocks.findOne).toHaveBeenCalledTimes(6);
  });

  it('concurrent likes never throw VersionError — each contending write retries into success', async () => {
    // Model contention deterministically: the first 3 saves (the first attempt
    // of each of the 3 concurrent interactions) lose the `__v` race and raise a
    // VersionError; once contention clears, the retry saves commit. Each
    // `findOne` returns a FRESH revision, mirroring the DB re-read on retry.
    const savedDocs: MockBehavior[] = [];
    let saveCount = 0;
    const CONFLICTING_SAVES = 3;
    mocks.findOne.mockImplementation(async () => {
      const doc = makeBehavior();
      doc.save = vi.fn().mockImplementation(async () => {
        saveCount += 1;
        if (saveCount <= CONFLICTING_SAVES) {
          throw makeVersionError();
        }
        savedDocs.push(doc);
      });
      return doc;
    });

    const results = await Promise.allSettled([
      userPreferenceService.recordInteraction('viewer-1', 'p1', 'like'),
      userPreferenceService.recordInteraction('viewer-1', 'p1', 'like'),
      userPreferenceService.recordInteraction('viewer-1', 'p1', 'like'),
    ]);

    // No interaction rejected — every conflict was retried into a success.
    for (const r of results) {
      expect(r.status).toBe('fulfilled');
    }
    // All three interactions committed, and each committed doc carries the like.
    expect(savedDocs).toHaveLength(3);
    for (const doc of savedDocs) {
      expect(doc.preferredAuthors.find(a => a.authorId === 'author-1')?.interactionTypes.likes).toBe(1);
    }
  });
});
