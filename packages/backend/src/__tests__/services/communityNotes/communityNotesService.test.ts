import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The translator between a Mention post and a CrowdSource note.
 *
 * What is worth asserting here is not "the SDK was called" — it is the three
 * decisions this module makes that nothing downstream can correct:
 *
 *   1. A page of posts costs ONE lookup, and a page of posts with no notes
 *      costs none at all the second time. The negative cache entry is the whole
 *      reason this is affordable on every feed request, and it is invisible
 *      unless a test looks for the absence of a second call.
 *   2. A failed lookup is an empty answer, never an error and never a cached
 *      "this post has no note" — the difference between a feed that degrades
 *      and a feed that remembers an outage for five minutes.
 *   3. The principal ids that travel. A note carries its writer AND the subject's
 *      author, because the exclusions CrowdSource enforces (nobody rates their
 *      own note, nobody rates a note about their own post) are enforceable only
 *      against ids it was given.
 */

const { client, store } = vi.hoisted(() => ({
  client: {
    communityNotes: {
      shown: vi.fn(),
      write: vi.fn(),
      withdraw: vi.fn(),
      drawToRate: vi.fn(),
      rate: vi.fn(),
      writtenBy: vi.fn(),
      ratedBy: vi.fn(),
    },
  },
  store: new Map<string, unknown>(),
}));

const enabled = { value: true };

vi.mock('../../../services/moderation/crowdSourceClient', () => ({
  getCrowdSourceClient: () => (enabled.value ? client : undefined),
}));

// An in-memory stand-in for the Redis cache. The real one fails open, so with no
// Redis every read would be a miss and the negative-entry behaviour below —the
// point of the exercise— could not be observed at all.
vi.mock('../../../utils/cache', () => ({
  createCache: () => ({
    getMany: async (keys: string[]) => keys.map((key) => (store.has(key) ? store.get(key) : undefined)),
    setMany: async (entries: Iterable<readonly [string, unknown]>) => {
      for (const [key, value] of entries) store.set(key, value);
    },
    delete: async (keys: string[]) => {
      for (const key of keys) store.delete(key);
    },
  }),
}));

import {
  communityNotesEnabled,
  communityNotesRatedBy,
  communityNotesWrittenBy,
  drawCommunityNotesToRate,
  invalidateShownNote,
  loadShownNotes,
  rateCommunityNote,
  withdrawCommunityNote,
  writeCommunityNote,
  CommunityNotesUnavailableError,
} from '../../../services/communityNotes/CommunityNotesService';

const note = (id: string, subject: string, over: Record<string, unknown> = {}) => ({
  id,
  externalSubjectId: subject,
  language: 'en',
  text: `note ${id}`,
  sourceUrls: ['https://example.org/source'],
  status: 'shown',
  createdAt: '2026-09-18T00:00:00.000Z',
  statusChangedAt: '2026-09-18T00:00:00.000Z',
  ...over,
});

beforeEach(() => {
  enabled.value = true;
  store.clear();
  for (const fn of Object.values(client.communityNotes)) fn.mockReset();
});

describe('shown-note lookup', () => {
  it('asks once for a page and attaches each note to its own post', async () => {
    client.communityNotes.shown.mockResolvedValue([note('n1', 'p1'), note('n3', 'p3')]);

    const notes = await loadShownNotes(['p1', 'p2', 'p3']);

    expect(client.communityNotes.shown).toHaveBeenCalledTimes(1);
    expect(client.communityNotes.shown).toHaveBeenCalledWith(['p1', 'p2', 'p3']);
    expect(notes.get('p1')?.text).toBe('note n1');
    expect(notes.get('p3')?.id).toBe('n3');
    expect(notes.has('p2')).toBe(false);
  });

  it('remembers that a post has no note, so a second page asks about nothing', async () => {
    client.communityNotes.shown.mockResolvedValue([note('n1', 'p1')]);
    await loadShownNotes(['p1', 'p2']);

    const again = await loadShownNotes(['p1', 'p2']);

    expect(client.communityNotes.shown).toHaveBeenCalledTimes(1);
    expect(again.get('p1')?.id).toBe('n1');
    expect(again.has('p2')).toBe(false);
  });

  it('asks only about the posts it has no answer for', async () => {
    client.communityNotes.shown.mockResolvedValueOnce([note('n1', 'p1')]);
    await loadShownNotes(['p1']);
    client.communityNotes.shown.mockResolvedValueOnce([]);

    await loadShownNotes(['p1', 'p2']);

    expect(client.communityNotes.shown).toHaveBeenLastCalledWith(['p2']);
  });

  it('splits a list longer than one lookup into whole lookups', async () => {
    const posts = Array.from({ length: 51 }, (_, index) => `p${index}`);
    client.communityNotes.shown.mockResolvedValue([]);

    await loadShownNotes(posts);

    expect(client.communityNotes.shown).toHaveBeenCalledTimes(2);
    expect(client.communityNotes.shown.mock.calls[0]?.[0]).toHaveLength(50);
    expect(client.communityNotes.shown.mock.calls[1]?.[0]).toEqual(['p50']);
  });

  it('deduplicates repeated ids and drops empty ones', async () => {
    client.communityNotes.shown.mockResolvedValue([]);

    await loadShownNotes(['p1', 'p1', '']);

    expect(client.communityNotes.shown).toHaveBeenCalledWith(['p1']);
  });

  it('answers with nothing when CrowdSource does not answer, and remembers nothing', async () => {
    client.communityNotes.shown.mockRejectedValue(new Error('gateway'));

    const notes = await loadShownNotes(['p1']);
    expect(notes.size).toBe(0);

    client.communityNotes.shown.mockResolvedValue([note('n1', 'p1')]);
    const retry = await loadShownNotes(['p1']);
    expect(retry.get('p1')?.id).toBe('n1');
  });

  it('never caches a note under a post nobody asked about', async () => {
    client.communityNotes.shown.mockResolvedValue([note('n9', 'somebody-elses-post')]);

    await loadShownNotes(['p1']);
    client.communityNotes.shown.mockResolvedValue([]);
    const second = await loadShownNotes(['somebody-elses-post']);

    expect(second.size).toBe(0);
    expect(client.communityNotes.shown).toHaveBeenLastCalledWith(['somebody-elses-post']);
  });

  it('costs nothing at all when the integration is off', async () => {
    enabled.value = false;

    expect(communityNotesEnabled()).toBe(false);
    expect((await loadShownNotes(['p1'])).size).toBe(0);
    expect(client.communityNotes.shown).not.toHaveBeenCalled();
  });

  it('forgets a post on demand', async () => {
    client.communityNotes.shown.mockResolvedValue([note('n1', 'p1')]);
    await loadShownNotes(['p1']);

    await invalidateShownNote('p1');
    await loadShownNotes(['p1']);

    expect(client.communityNotes.shown).toHaveBeenCalledTimes(2);
  });
});

describe('writing', () => {
  it('names the writer and the subject author, and drops the cached answer', async () => {
    client.communityNotes.shown.mockResolvedValue([]);
    await loadShownNotes(['p1']);
    client.communityNotes.write.mockResolvedValue(note('n1', 'p1', { status: 'needs_ratings' }));

    const written = await writeCommunityNote({
      viewerId: 'viewer-1',
      postId: 'p1',
      postAuthorId: 'author-1',
      language: 'es',
      text: 'context',
      sourceUrls: ['https://example.org/s'],
    });

    expect(client.communityNotes.write).toHaveBeenCalledWith({
      externalSubjectId: 'p1',
      subjectAuthorPrincipalId: 'author-1',
      authorPrincipalId: 'viewer-1',
      language: 'es',
      text: 'context',
      sourceUrls: ['https://example.org/s'],
    });
    expect(written.status).toBe('needs_ratings');
    // The negative entry cached a moment ago is gone.
    await loadShownNotes(['p1']);
    expect(client.communityNotes.shown).toHaveBeenCalledTimes(2);
  });

  it('withdraws by the note, and forgets the post it was under', async () => {
    client.communityNotes.shown.mockResolvedValue([note('n1', 'p1')]);
    await loadShownNotes(['p1']);
    client.communityNotes.withdraw.mockResolvedValue(note('n1', 'p1', { status: 'withdrawn' }));

    const withdrawn = await withdrawCommunityNote('viewer-1', 'n1');

    expect(client.communityNotes.withdraw).toHaveBeenCalledWith('n1', 'viewer-1');
    expect(withdrawn.status).toBe('withdrawn');
    await loadShownNotes(['p1']);
    expect(client.communityNotes.shown).toHaveBeenCalledTimes(2);
  });

  it('refuses to act when the integration is off, rather than pretending it worked', async () => {
    enabled.value = false;
    await expect(
      writeCommunityNote({
        viewerId: 'v',
        postId: 'p',
        postAuthorId: 'a',
        language: 'en',
        text: 't',
        sourceUrls: [],
      }),
    ).rejects.toBeInstanceOf(CommunityNotesUnavailableError);
  });
});

describe('rating', () => {
  it('draws with the caller’s key and caps the languages CrowdSource accepts', async () => {
    client.communityNotes.drawToRate.mockResolvedValue([
      { id: 'a1', note: note('n1', 'p1', { status: 'needs_ratings' }), expiresAt: '2026-09-19T00:00:00.000Z' },
    ]);

    const drawn = await drawCommunityNotesToRate('viewer-1', ['es', 'en', 'fr', 'de', 'it', 'pt'], 'key-1');

    expect(client.communityNotes.drawToRate).toHaveBeenCalledWith(
      { raterPrincipalId: 'viewer-1', languages: ['es', 'en', 'fr', 'de', 'it'], limit: 10 },
      { idempotencyKey: 'key-1' },
    );
    expect(drawn[0]).toMatchObject({ postId: 'p1', expiresAt: '2026-09-19T00:00:00.000Z' });
  });

  it('falls back to a language a rater can be offered notes in', async () => {
    client.communityNotes.drawToRate.mockResolvedValue([]);

    await drawCommunityNotesToRate('viewer-1', [], 'key-1');

    expect(client.communityNotes.drawToRate.mock.calls[0]?.[0]).toMatchObject({ languages: ['en'] });
  });

  it('sends the rating and its reasons together', async () => {
    client.communityNotes.rate.mockResolvedValue({});

    await rateCommunityNote('viewer-1', 'n1', { rating: 'not_helpful', reasons: ['incorrect'] });

    expect(client.communityNotes.rate).toHaveBeenCalledWith('n1', {
      raterPrincipalId: 'viewer-1',
      rating: 'not_helpful',
      reasons: ['incorrect'],
    });
  });
});

describe('the viewer’s own lists', () => {
  it('returns each written note with the post it is about', async () => {
    client.communityNotes.writtenBy.mockResolvedValue([note('n1', 'p1', { status: 'not_shown' })]);

    const written = await communityNotesWrittenBy('viewer-1');

    expect(client.communityNotes.writtenBy).toHaveBeenCalledWith('viewer-1');
    expect(written).toEqual([
      expect.objectContaining({ postId: 'p1', note: expect.objectContaining({ status: 'not_shown' }) }),
    ]);
    expect(written[0]?.note).not.toHaveProperty('viewerRating');
  });

  it('carries the rating the viewer gave onto the note they rated', async () => {
    client.communityNotes.ratedBy.mockResolvedValue([
      { rating: { id: 'r1', noteId: 'n1', rating: 'helpful', reasons: ['relevant'], ratedAt: 'now' }, note: note('n1', 'p1') },
    ]);

    const rated = await communityNotesRatedBy('viewer-1');

    expect(rated[0]?.note.viewerRating).toBe('helpful');
  });
});
