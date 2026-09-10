import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CachedUserSummary } from '../../services/userSummaryCache';
import type { ClarityDocument } from '@oxy.so/contracts';

/**
 * Verifies that `PostHydrationService` sources link previews from Clarity and maps the
 * `'resolved'` {@link ClarityDocument}s onto the post DTO's `documents` array, in
 * text order — sizing the Oxy-hosted (`cloud.oxy.so`) `image` down to the
 * `w320` (`MEDIA_VARIANT_THUMB`) context via `attachCdnVariant` instead of
 * serving the no-variant original (never re-proxied, still Oxy-hosted). A
 * `'pending'`/`'empty'`/missing preview becomes a URL-only card without
 * disturbing the order of the resolved ones, and a preview-service failure
 * never fails feed hydration or suppresses those fallback cards.
 */

const POST_ID = '650000000000000000000010';
const AUTHOR_OXY_ID = 'oxy-author';
const POST_URL = 'https://example.com/some-article';
const SECOND_URL = 'https://example.org/another-article';

const { getUserById, getUsersByIds, resolveDocuments, cacheStore } = vi.hoisted(() => ({
  getUserById: vi.fn(),
  getUsersByIds: vi.fn(),
  resolveDocuments: vi.fn(),
  cacheStore: new Map<string, CachedUserSummary>(),
}));

vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({
    getUserById,
    getUserFollowing: vi.fn(async () => []),
    getUserFollowers: vi.fn(async () => []),
  }),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ getUsersByIds, getCloudURL: () => 'https://cloud.oxy.so' }),
}));

vi.mock('../../utils/clarityClient', () => ({
  getClarityClient: async () => ({ indexing: { resolve: resolveDocuments } }),
}));

vi.mock('../../utils/privacyHelpers', () => ({
  getBlockedUserIds: vi.fn(async () => []),
  getRestrictedUserIds: vi.fn(async () => []),
  extractFollowingIds: vi.fn(() => []),
  extractFollowersIds: vi.fn(() => []),
}));

// A chainable Mongoose query stub: `.select().sort().limit().maxTimeMS().lean()`.
function chainable(rows: unknown[] | null) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'sort', 'limit', 'maxTimeMS']) {
    q[m] = () => q;
  }
  q.lean = async () => rows;
  q.then = undefined;
  return q;
}

vi.mock('../../services/userSummaryCache', () => ({
  mget: vi.fn(async (ids: string[]) => {
    const hits = new Map<string, CachedUserSummary>();
    for (const id of ids) {
      const hit = cacheStore.get(id);
      if (hit) hits.set(id, hit);
    }
    return hits;
  }),
  mset: vi.fn(async (entries: Map<string, CachedUserSummary>) => {
    for (const [id, value] of entries) cacheStore.set(id, value);
  }),
}));

import { PostHydrationService } from '../../services/PostHydrationService';
import { FEDERATION_DOMAIN } from '../../connectors/activitypub/constants';

function makeOxyUser(id: string, username: string, displayName: string) {
  return { id, username, name: { displayName }, badges: [], verified: false, isVerified: false };
}

function postRow(text: string = `look at this ${POST_URL}`) {
  return {
    _id: POST_ID,
    oxyUserId: AUTHOR_OXY_ID,
    type: 'post',
    // Stored content is normalized: the body lives on the primary rendition, and
    // the URLs previewed are the ones in the rendition the reader is served.
    content: { variants: [{ tag: 'en', source: 'author', text }] },
    stats: { likesCount: 0, boostsCount: 0, commentsCount: 0, downvotesCount: 0, viewsCount: 0 },
    metadata: { createdAt: new Date('2024-01-01T00:00:00Z') },
    createdAt: new Date('2024-01-01T00:00:00Z'),
    visibility: 'public',
    hashtags: [],
    mentions: [],
  };
}

describe('PostHydrationService — documents sourced from Clarity', () => {
  let service: PostHydrationService;

  beforeEach(() => {
    cacheStore.clear();
    getUserById.mockReset();
    getUsersByIds.mockReset();
    resolveDocuments.mockReset();
    getUsersByIds.mockResolvedValue([makeOxyUser(AUTHOR_OXY_ID, 'author', 'Author')]);
    service = new PostHydrationService();
  });

  async function hydrate(text?: string) {
    const [hydrated] = await service.hydratePosts([postRow(text)], {
      viewerId: undefined,
      maxDepth: 0,
      includeLinkMetadata: true,
      includeFullMetadata: false,
    });
    return hydrated;
  }

  function resolvedPreview(url: string, title: string): ClarityDocument {
    return {
      id: `doc-${title}`,
      canonicalUrl: url,
      title,
      description: `${title} description`,
      // No variant on the source — proves the service attaches one, not just
      // preserves a pre-existing param.
      imageUrl: 'https://cloud.oxy.so/file123',
      publisher: { name: 'Example' },
      faviconUrl: 'https://cloud.oxy.so/favicon456',
      type: 'article',
      indexedAt: new Date().toISOString(),
    };
  }

  function mockDocuments(documents: Record<string, ClarityDocument>): void {
    resolveDocuments.mockResolvedValue({
      data: Object.entries(documents).map(([url, document]) => ({ url, status: 'resolved', document })),
    });
  }

  it('maps a resolved Oxy ClarityDocument onto the post, sizing the cloud.oxy.so image to the thumb (w320) variant', async () => {
    const resolved: ClarityDocument = {
      id: 'doc-1',
      canonicalUrl: 'https://example.com/some-article?canonical=1',
      title: 'Some Article',
      description: 'A description',
      // Already carries an unrelated variant — proves the service OVERWRITES
      // it (idempotent `set`) rather than appending a duplicate param.
      imageUrl: 'https://cloud.oxy.so/file123?variant=w2048',
      publisher: { name: 'Example' },
      faviconUrl: 'https://cloud.oxy.so/favicon456',
      type: 'article',
      indexedAt: new Date().toISOString(),
    };
    resolveDocuments.mockResolvedValue({ data: [{ url: POST_URL, status: 'resolved', document: resolved }] });

    const hydrated = await hydrate();

    // The service requested exactly the extracted URL.
    expect(resolveDocuments).toHaveBeenCalledTimes(1);
    expect(resolveDocuments).toHaveBeenCalledWith({ urls: [POST_URL], waitMs: 2_000 });

    expect(hydrated.documents).toEqual([
      {
        ...resolved,
        title: 'Some Article',
        description: 'A description',
        // Oxy-hosted image is never re-proxied, but sized to w320 instead of
        // serving the no-variant original (or an unrelated variant).
        imageUrl: 'https://cloud.oxy.so/file123?variant=w2048',
      },
    ]);
  });

  it('leaves a non-Oxy-hosted image untouched (never attaches our variant to a third-party host)', async () => {
    const resolved: ClarityDocument = {
      id: 'doc-2',
      canonicalUrl: 'https://example.com/some-article?canonical=1',
      title: 'External image',
      description: 'A description',
      imageUrl: 'https://images.example.com/og-image.png',
      publisher: { name: 'Example' },
      type: 'article',
      indexedAt: new Date().toISOString(),
    };
    resolveDocuments.mockResolvedValue({ data: [{ url: POST_URL, status: 'resolved', document: resolved }] });

    const hydrated = await hydrate();

    expect(hydrated.documents?.[0]?.imageUrl).toBe('https://images.example.com/og-image.png');
  });

  it('maps every resolved preview of a multi-link post, in text order', async () => {
    mockDocuments({
      [POST_URL]: resolvedPreview(POST_URL, 'First'),
      [SECOND_URL]: resolvedPreview(SECOND_URL, 'Second'),
    });

    const hydrated = await hydrate(`two links: ${SECOND_URL} and ${POST_URL}`);

    expect(resolveDocuments).toHaveBeenCalledWith({ urls: [SECOND_URL, POST_URL], waitMs: 2_000 });
    expect(hydrated.documents?.map((preview) => preview.canonicalUrl)).toEqual([SECOND_URL, POST_URL]);
    expect(hydrated.documents?.map((preview) => preview.title)).toEqual(['Second', 'First']);
  });

  it('omits a pending document without disturbing resolved document order', async () => {
    const thirdUrl = 'https://example.net/third-article';
    resolveDocuments.mockResolvedValue({ data: [
      { url: POST_URL, status: 'resolved', document: resolvedPreview(POST_URL, 'First') },
      { url: SECOND_URL, status: 'pending' },
      { url: thirdUrl, status: 'resolved', document: resolvedPreview(thirdUrl, 'Third') },
    ] });

    const hydrated = await hydrate(`${POST_URL} ${SECOND_URL} ${thirdUrl}`);

    expect(hydrated.documents).toEqual([
      expect.objectContaining({ canonicalUrl: POST_URL, title: 'First' }),
      expect.objectContaining({ canonicalUrl: thirdUrl, title: 'Third' }),
    ]);
  });

  it('omits a pending document until Clarity resolves it', async () => {
    resolveDocuments.mockResolvedValue({ data: [{ url: POST_URL, status: 'pending' }] });

    const hydrated = await hydrate();
    expect(hydrated.documents).toEqual([]);
  });

  it('omits a failed document resolution', async () => {
    resolveDocuments.mockResolvedValue({ data: [{ url: POST_URL, status: 'failed' }] });

    const hydrated = await hydrate();
    expect(hydrated.documents).toEqual([]);
  });

  it('omits a missing batch result', async () => {
    resolveDocuments.mockResolvedValue({ data: [] });

    const hydrated = await hydrate();
    expect(hydrated.documents).toEqual([]);
  });

  it('still hydrates the post when Clarity throws', async () => {
    resolveDocuments.mockRejectedValue(new Error('clarity down'));

    const hydrated = await hydrate();
    expect(hydrated).toBeTruthy();
    expect(hydrated.id).toBe(POST_ID);
    expect(hydrated.documents).toEqual([]);
  });

  it('does not call the preview service when includeLinkMetadata is false', async () => {
    resolveDocuments.mockResolvedValue({ data: [] });

    await service.hydratePosts([postRow()], {
      viewerId: undefined,
      maxDepth: 0,
      includeLinkMetadata: false,
      includeFullMetadata: false,
    });

    expect(resolveDocuments).not.toHaveBeenCalled();
  });

  /**
   * A URL naming a profile on THIS instance is rendered as a mention by the
   * reader's linkifier, so a card under it would preview a page the reader can no
   * longer see a link to. These assert the card is withheld — and, just as
   * importantly, that nothing else loses one.
   */
  describe('a profile link on this instance gets no card', () => {
    // The suite builds its URLs from the configured federation domain's DEFAULT.
    // Asserting it keeps the cases below from going vacuous if that config
    // changes: they would then be exercising a host the service does not treat
    // as ours, and would pass for the wrong reason.
    it('is exercising the host the service actually treats as ours', () => {
      expect(FEDERATION_DOMAIN).toBe('mention.earth');
    });

    it.each([
      ['a profile page', 'https://mention.earth/@alice'],
      ['a federated profile page', 'https://mention.earth/@bob@mastodon.social'],
      ['an actor URI', 'https://mention.earth/ap/users/alice'],
    ])('asks for no preview of %s', async (_label, url) => {
      resolveDocuments.mockResolvedValue({ data: [] });

      const hydrated = await hydrate(`mira ${url}`);

      // Dropped BEFORE the batch call — the preview service is never asked to
      // scrape our own profile page.
      expect(resolveDocuments).not.toHaveBeenCalled();
      expect(hydrated.documents).toEqual([]);
    });

    it('still gives the other link its card', async () => {
      mockDocuments({ [POST_URL]: resolvedPreview(POST_URL, 'First') });

      const hydrated = await hydrate(`https://mention.earth/@alice wrote ${POST_URL}`);

      // The gate suppresses one entry, not the map.
      expect(resolveDocuments).toHaveBeenCalledWith({ urls: [POST_URL], waitMs: 2_000 });
      expect(hydrated.documents?.map((preview) => preview.canonicalUrl)).toEqual([POST_URL]);
    });

    it('keeps the card for a profile URL on ANY OTHER host', async () => {
      // The renderer leaves these as links, because whether we hold that account
      // is not readable from the characters — so the card has to stay too.
      const remote = 'https://mastodon.social/@bob';
      mockDocuments({ [remote]: resolvedPreview(remote, 'Bob') });

      const hydrated = await hydrate(`mira ${remote}`);

      expect(resolveDocuments).toHaveBeenCalledWith({ urls: [remote], waitMs: 2_000 });
      expect(hydrated.documents?.map((preview) => preview.canonicalUrl)).toEqual([remote]);
    });

    it('keeps the card for one of our own pages that is not a profile', async () => {
      const ourPost = 'https://mention.earth/p/650000000000000000000099';
      mockDocuments({ [ourPost]: resolvedPreview(ourPost, 'A post') });

      const hydrated = await hydrate(`mira ${ourPost}`);

      expect(resolveDocuments).toHaveBeenCalledWith({ urls: [ourPost], waitMs: 2_000 });
      expect(hydrated.documents?.map((preview) => preview.canonicalUrl)).toEqual([ourPost]);
    });

    it('keeps the card for a sub-page of one of our profiles', async () => {
      const followers = 'https://mention.earth/@alice/followers';
      mockDocuments({ [followers]: resolvedPreview(followers, 'Followers') });

      const hydrated = await hydrate(`mira ${followers}`);

      expect(resolveDocuments).toHaveBeenCalledWith({ urls: [followers], waitMs: 2_000 });
      expect(hydrated.documents?.map((preview) => preview.canonicalUrl)).toEqual([followers]);
    });
  });
});
