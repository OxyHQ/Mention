import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Outbound federation for a batch written in one action
 * (`connectors/threadFederation.ts`).
 *
 * Four behaviours are load-bearing here and each is pinned against the input
 * shape that tells it apart from the rule beside it:
 *
 *  - a CHAIN federates every entry in publication order, a beast batch federates
 *    them independently — the difference only shows when one entry cannot go
 *    out, so every refusal is asserted in BOTH shapes, from the same fixture;
 *  - a chain STOPS at a refusal rather than skipping it, so every assertion is
 *    about the entries AFTER the refused one, which is exactly what a skip would
 *    still have delivered. A fixture whose accounts all answer the same way, or
 *    that ends at the refusal, cannot tell the two apart;
 *  - the extra-audience list names the OTHER participants, so a single-voice
 *    thread and a beast batch are asserted to pass an empty one.
 */

const { isFediverseSharingEnabled, federatePublishedPost } = vi.hoisted(() => ({
  isFediverseSharingEnabled: vi.fn<(oxyUserId: string) => Promise<boolean>>(),
  federatePublishedPost: vi.fn<() => Promise<boolean>>(),
}));

vi.mock('../../services/fediverseSharing', () => ({ isFediverseSharingEnabled }));

vi.mock('../../services/PostCreationService', () => ({
  postCreationService: { federatePublishedPost },
}));

import { federatePostBatch, federatePostBatchDetached } from '../../connectors/threadFederation';
import type { IPost } from '../../models/Post';

/** A minimal created row: the batch path reads only the author off it. */
function entry(id: string, oxyUserId: string): IPost {
  return { _id: id, oxyUserId } as unknown as IPost;
}

/** The (post id, author) pairs handed to federation, in call order. */
function federatedIds(): string[] {
  return federatePublishedPost.mock.calls.map((call) => String((call[0] as IPost)._id));
}

/** The call arguments recorded for the entry with this id. */
function callFor(postId: string): { oxyUserId?: string; alsoDeliverToAudiencesOf?: string[] } | undefined {
  const call = federatePublishedPost.mock.calls.find(
    (c) => String((c[0] as IPost)._id) === postId,
  );
  return call?.[1] as { oxyUserId?: string; alsoDeliverToAudiencesOf?: string[] } | undefined;
}

/** The extra-audience list passed alongside the entry with this id. */
function audiencesFor(postId: string): string[] | undefined {
  return callFor(postId)?.alsoDeliverToAudiencesOf;
}

/** Sharing is ON for everybody except the named accounts. */
function sharingOffFor(...accounts: string[]): void {
  isFediverseSharingEnabled.mockImplementation(async (id: string) => !accounts.includes(id));
}

beforeEach(() => {
  vi.clearAllMocks();
  sharingOffFor();
  federatePublishedPost.mockResolvedValue(true);
});

describe('federatePostBatch — the happy paths', () => {
  it('federates every entry of a single-voice thread, in publication order', async () => {
    await federatePostBatch({
      entries: [entry('p1', 'alice'), entry('p2', 'alice'), entry('p3', 'alice')],
      shape: 'chain',
    });

    expect(federatedIds()).toEqual(['p1', 'p2', 'p3']);
  });

  it('federates each entry of a cross-account thread as ITS OWN author', async () => {
    // The author decides whose followers receive the entry, so it has to be read
    // per entry. A thread of one account cannot show that — every candidate
    // answer is the same account — so the fixture alternates deliberately.
    await federatePostBatch({
      entries: [entry('p1', 'alice'), entry('p2', 'org'), entry('p3', 'alice')],
      shape: 'chain',
    });

    expect(callFor('p1')?.oxyUserId).toBe('alice');
    expect(callFor('p2')?.oxyUserId).toBe('org');
    expect(callFor('p3')?.oxyUserId).toBe('alice');
  });

  it('federates every entry of a beast batch', async () => {
    await federatePostBatch({
      entries: [entry('p1', 'alice'), entry('p2', 'org'), entry('p3', 'alice')],
      shape: 'independent',
    });

    expect(federatedIds()).toEqual(['p1', 'p2', 'p3']);
  });

  it('reads consent once per DISTINCT account, however long the thread', async () => {
    await federatePostBatch({
      entries: [
        entry('p1', 'alice'),
        entry('p2', 'alice'),
        entry('p3', 'alice'),
        entry('p4', 'alice'),
      ],
      shape: 'chain',
    });

    expect(isFediverseSharingEnabled).toHaveBeenCalledTimes(1);
    expect(isFediverseSharingEnabled).toHaveBeenCalledWith('alice');
  });

  it('does nothing at all for an empty batch', async () => {
    await federatePostBatch({ entries: [], shape: 'chain' });

    expect(federatePublishedPost).not.toHaveBeenCalled();
    expect(isFediverseSharingEnabled).not.toHaveBeenCalled();
  });
});

describe('federatePostBatch — an author who does not share ends the chain', () => {
  /**
   * Every fixture here mixes a sharing account with a non-sharing one, and every
   * assertion is about the entries AFTER the refused one. A batch whose accounts
   * all answered the same way could not tell a stop from a skip, and neither
   * could one that ended at the refusal.
   */

  it('federates nothing at all when the ROOT author does not share, whoever answers', async () => {
    // The leak this exists to prevent: bob shares and would happily federate, but
    // his entries answer alice's, and publishing them puts `@alice@<domain>` and
    // the url of a post she kept off the fediverse onto every instance that
    // receives them. p2 and p3 are what a skip would have delivered.
    sharingOffFor('alice');

    await federatePostBatch({
      entries: [entry('p1', 'alice'), entry('p2', 'bob'), entry('p3', 'bob')],
      shape: 'chain',
    });

    expect(federatedIds()).toEqual([]);
  });

  it('stops at a silent account in the MIDDLE, dropping the sharing entry behind it', async () => {
    // bob opens and shares; alice answers and does not; bob answers alice. p1 is
    // reached, p3 must not be — it answers a post that stayed home.
    sharingOffFor('alice');

    await federatePostBatch({
      entries: [entry('p1', 'bob'), entry('p2', 'alice'), entry('p3', 'bob')],
      shape: 'chain',
    });

    expect(federatedIds()).toEqual(['p1']);
  });

  it('removes only the silent account\'s own posts from a beast batch', async () => {
    // The SAME accounts in the SAME order as the chain case above, so the two
    // shapes are told apart by their results and not by their fixtures. A beast
    // entry answers nothing, so nothing downstream depends on alice.
    sharingOffFor('alice');

    await federatePostBatch({
      entries: [entry('p1', 'bob'), entry('p2', 'alice'), entry('p3', 'bob')],
      shape: 'independent',
    });

    expect(federatedIds()).toEqual(['p1', 'p3']);
  });

  it('treats an entry with no resolvable author as not sharing, and stops there', async () => {
    // An unresolvable author is absent from the consent map. Reading that as
    // "sharing" is the unsafe direction, so p2 and p3 pin which way it falls.
    await federatePostBatch({
      entries: [entry('p1', 'alice'), entry('p2', ''), entry('p3', 'alice')],
      shape: 'chain',
    });

    expect(federatedIds()).toEqual(['p1']);
  });
});

describe('federatePostBatch — a link that did not go out', () => {
  it('stops the chain after an entry federation refused to deliver', async () => {
    federatePublishedPost.mockImplementation(async (...args: unknown[]) => {
      return String((args[0] as IPost)._id) !== 'p2';
    });

    await federatePostBatch({
      entries: [entry('p1', 'alice'), entry('p2', 'alice'), entry('p3', 'alice')],
      shape: 'chain',
    });

    // p3 is what discriminates: a skip would still have delivered it.
    expect(federatedIds()).toEqual(['p1', 'p2']);
  });

  it('keeps going through an undelivered entry in a beast batch', async () => {
    federatePublishedPost.mockImplementation(async (...args: unknown[]) => {
      return String((args[0] as IPost)._id) !== 'p2';
    });

    await federatePostBatch({
      entries: [entry('p1', 'alice'), entry('p2', 'alice'), entry('p3', 'alice')],
      shape: 'independent',
    });

    expect(federatedIds()).toEqual(['p1', 'p2', 'p3']);
  });
});

describe('federatePostBatch — the other participants of a cross-account thread', () => {
  it('offers each entry to the OTHER accounts of the thread, never to its own', async () => {
    await federatePostBatch({
      entries: [entry('p1', 'alice'), entry('p2', 'org'), entry('p3', 'alice')],
      shape: 'chain',
    });

    expect(audiencesFor('p1')).toEqual(['org']);
    expect(audiencesFor('p2')).toEqual(['alice']);
    expect(audiencesFor('p3')).toEqual(['org']);
  });

  it('offers nothing extra on a single-voice thread', async () => {
    await federatePostBatch({
      entries: [entry('p1', 'alice'), entry('p2', 'alice')],
      shape: 'chain',
    });

    expect(audiencesFor('p1')).toEqual([]);
    expect(audiencesFor('p2')).toEqual([]);
  });

  it('offers nothing extra in a beast batch, whose entries share no conversation', async () => {
    await federatePostBatch({
      entries: [entry('p1', 'alice'), entry('p2', 'org')],
      shape: 'independent',
    });

    expect(audiencesFor('p1')).toEqual([]);
    expect(audiencesFor('p2')).toEqual([]);
  });

  it('leaves a non-sharing participant out of the audience list', async () => {
    // A three-account thread where the middle account does not federate. The
    // chain stops at that account's entry, so the ROOT is the only one delivered
    // — and its audience must not name the silent account.
    sharingOffFor('org');

    await federatePostBatch({
      entries: [entry('p1', 'alice'), entry('p2', 'org'), entry('p3', 'carol')],
      shape: 'chain',
    });

    expect(federatedIds()).toEqual(['p1']);
    expect(audiencesFor('p1')).toEqual(['carol']);
  });
});

describe('federatePostBatchDetached', () => {
  it('never lets a failure escape as an unhandled rejection', async () => {
    federatePublishedPost.mockRejectedValue(new Error('connector exploded'));

    expect(() =>
      federatePostBatchDetached({ entries: [entry('p1', 'alice')], shape: 'chain' }),
    ).not.toThrow();

    // Let the detached promise settle; the rejection handler is what keeps this
    // from failing the run.
    await new Promise((resolve) => setImmediate(resolve));
    expect(federatePublishedPost).toHaveBeenCalledTimes(1);
  });
});
