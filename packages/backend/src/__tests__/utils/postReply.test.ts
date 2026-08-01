import { describe, expect, it } from 'vitest';

/**
 * Regression harness for the "reply rendered as a top-level post" bug.
 *
 * A post's parent lives in two places: `parentPostId` (the LOCAL join) and
 * `federation.inReplyTo` (the AP IRI). They diverge for a federated reply whose
 * parent could not be resolved or bounded-backfilled at ingest — the reply keeps
 * its IRI and `parentPostId` stays null.
 *
 * Reading `parentPostId == null` as "not a reply" therefore leaked such replies
 * into the discovery lanes that explicitly exclude replies (trending, explore,
 * rising creators, popular-with-friends) AND hid them from the lanes that
 * explicitly select replies. These tests pin both directions to the ONE shared
 * definition in `utils/postReply`.
 *
 * Offline by construction: the clauses are declarative objects and the predicate
 * is pure, so no MongoDB is involved (matching the repo's model-test convention).
 */

import {
  isReplyClause,
  isReplyPost,
  notAReplyClause,
  restrictToReplies,
  restrictToRoots,
} from '../../utils/postReply';
import { noRepliesFilter, onlyRepliesFilter } from '../../mtn/feed/engine/filters';
import type { CandidatePost } from '../../mtn/feed/engine/types';

const FEDERATED_IRI = 'https://remote.example/users/someone/statuses/1';

/** The four shapes a post's parent linkage can take. */
const LOCALLY_LINKED_REPLY = { parentPostId: '650000000000000000000001' };
const UNLINKED_FEDERATED_REPLY = {
  parentPostId: null,
  federation: { inReplyTo: FEDERATED_IRI },
};
const ROOT_POST = { parentPostId: null, federation: { inReplyTo: undefined } };
const ROOT_POST_NO_FEDERATION = {};

describe('isReplyPost', () => {
  it('recognizes a locally linked reply', () => {
    expect(isReplyPost(LOCALLY_LINKED_REPLY)).toBe(true);
  });

  it('recognizes a federated reply whose parent was never linked locally', () => {
    // THE bug: this shape used to read as a thread root everywhere.
    expect(isReplyPost(UNLINKED_FEDERATED_REPLY)).toBe(true);
  });

  it('treats a thread root as a root, with or without a federation subdocument', () => {
    expect(isReplyPost(ROOT_POST)).toBe(false);
    expect(isReplyPost(ROOT_POST_NO_FEDERATION)).toBe(false);
  });

  it('does not read an empty stored IRI as a parent', () => {
    expect(isReplyPost({ parentPostId: null, federation: { inReplyTo: '' } })).toBe(false);
  });

  it('ignores a null federation subdocument', () => {
    expect(isReplyPost({ parentPostId: null, federation: null })).toBe(false);
  });
});

describe('reply Mongo clauses', () => {
  it('both consult BOTH parent encodings', () => {
    // The whole point of the fix: a clause that names only `parentPostId` is the
    // bug. Asserting the key sets pins that a refactor cannot quietly drop the
    // federation arm.
    expect(Object.keys(notAReplyClause()).sort()).toEqual([
      'federation.inReplyTo',
      'parentPostId',
    ]);

    const orArms = isReplyClause().$or as Array<Record<string, unknown>>;
    expect(orArms.flatMap((arm) => Object.keys(arm)).sort()).toEqual([
      'federation.inReplyTo',
      'parentPostId',
    ]);
  });

  it('are exact duals — same sentinel set, opposite operators', () => {
    // `$in`/`$nin` over the identical `[null, '']` set is what guarantees no
    // document can satisfy both clauses or neither.
    const roots = notAReplyClause();
    const replies = isReplyClause().$or as Array<Record<string, unknown>>;

    expect(roots['federation.inReplyTo']).toEqual({ $in: [null, ''] });
    expect(roots.parentPostId).toBeNull();

    expect(replies).toEqual([
      { parentPostId: { $ne: null } },
      { 'federation.inReplyTo': { $nin: [null, ''] } },
    ]);
  });

  it('returns a fresh object per call so callers cannot mutate a shared literal', () => {
    const first = notAReplyClause();
    expect(first).not.toBe(notAReplyClause());
    expect(isReplyClause()).not.toBe(isReplyClause());
  });
});

describe('restrictToReplies / restrictToRoots', () => {
  it('append to `$and` instead of assigning `$or`', () => {
    // `ChronoCursor.applyToQuery` ASSIGNS `match.$or` for the keyset cursor. A
    // reply constraint written to `$or` would be silently dropped on page 2+ —
    // the exact hazard these helpers exist to remove.
    const query: Record<string, unknown> = { visibility: 'public' };
    restrictToReplies(query);

    expect(query.$or).toBeUndefined();
    expect(query.$and).toEqual([isReplyClause()]);
  });

  it('preserves a disjunction the caller already put on the query', () => {
    const cursorOr = [{ createdAt: { $lt: new Date(0) } }];
    const query: Record<string, unknown> = { $or: cursorOr };
    restrictToRoots(query);

    expect(query.$or).toBe(cursorOr);
    expect(query.$and).toEqual([notAReplyClause()]);
  });

  it('composes with an existing `$and` rather than replacing it', () => {
    const existing = { boostOf: null };
    const query: Record<string, unknown> = { $and: [existing] };
    restrictToRoots(query);

    expect(query.$and).toEqual([existing, notAReplyClause()]);
  });
});

describe('feed filter modules', () => {
  const candidate = (post: object) => post as CandidatePost;

  it('noReplies excludes a federated reply with no local parent link', () => {
    expect(noRepliesFilter.keep?.(candidate(ROOT_POST), {} as never, {})).toBe(true);
    expect(noRepliesFilter.keep?.(candidate(LOCALLY_LINKED_REPLY), {} as never, {})).toBe(false);
    // The leak that put a context-free reply into For You.
    expect(noRepliesFilter.keep?.(candidate(UNLINKED_FEDERATED_REPLY), {} as never, {})).toBe(false);
  });

  it('onlyReplies includes a federated reply with no local parent link', () => {
    expect(onlyRepliesFilter.keep?.(candidate(ROOT_POST), {} as never, {})).toBe(false);
    expect(onlyRepliesFilter.keep?.(candidate(LOCALLY_LINKED_REPLY), {} as never, {})).toBe(true);
    // The mirror-image miss: reply lanes could not see these posts at all.
    expect(onlyRepliesFilter.keep?.(candidate(UNLINKED_FEDERATED_REPLY), {} as never, {})).toBe(true);
  });

  it('the two filters partition every shape — no post is kept or dropped by both', () => {
    for (const post of [ROOT_POST, ROOT_POST_NO_FEDERATION, LOCALLY_LINKED_REPLY, UNLINKED_FEDERATED_REPLY]) {
      const keptAsRoot = noRepliesFilter.keep?.(candidate(post), {} as never, {});
      const keptAsReply = onlyRepliesFilter.keep?.(candidate(post), {} as never, {});
      expect(keptAsRoot).toBe(!keptAsReply);
    }
  });
});
