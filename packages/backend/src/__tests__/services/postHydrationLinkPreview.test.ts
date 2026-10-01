import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CachedUserSummary } from '../../services/userSummaryCache';
import type { ClarityDocument } from '@oxy.so/contracts';

/**
 * Verifies that `PostHydrationService` sources link previews from Clarity and maps
 * each returned {@link ClarityDocument} onto the post DTO's `documents` array, in
 * text order. A link Clarity is still indexing gets no card and marks the post
 * `documentsPending`, so the app asks again; a link Clarity gave up on gets no
 * card and no flag. A preview-service failure never fails feed hydration.
 *
 * The Clarity mock answers the way `POST /v1/resolve` does: one result per
 * requested URL, in request order.
 */

const POST_ID = '650000000000000000000010';
const AUTHOR_OXY_ID = 'oxy-author';
const POST_URL = 'https://example.com/some-article';
const SECOND_URL = 'https://example.org/another-article';

const { getUserById, getUsersByIds, resolveDocuments, findPostLinkPreviews, cacheStore } = vi.hoisted(() => ({
  getUserById: vi.fn(),
  getUsersByIds: vi.fn(),
  resolveDocuments: vi.fn(),
  findPostLinkPreviews: vi.fn(),
  cacheStore: new Map<string, CachedUserSummary>(),
}));

// The FEP-8967 cards a federated post arrived with (`post_link_previews`).
vi.mock('../../db/posts/postLinkPreviewRepository', () => ({ findPostLinkPreviews }));

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
    findPostLinkPreviews.mockReset();
    findPostLinkPreviews.mockResolvedValue(new Map());
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
    resolveDocuments.mockImplementation(async ({ urls }: { urls: string[] }) => ({
      data: urls.map((url) => (documents[url]
        ? { url, status: 'indexed', document: documents[url] }
        : { url, status: 'failed' })),
    }));
  }

  it('maps a resolved ClarityDocument onto the post, keeping the images Clarity serves', async () => {
    const resolved: ClarityDocument = {
      id: 'doc-1',
      canonicalUrl: 'https://example.com/some-article?canonical=1',
      title: 'Some Article',
      description: 'A description',
      imageUrl: 'https://api.clarity.surf/images/documents/doc-1/0123456789abcdef',
      publisher: 'Example',
      faviconUrl: 'https://api.clarity.surf/favicons/example.com',
      type: 'article',
      indexedAt: new Date().toISOString(),
    } as ClarityDocument;
    resolveDocuments.mockResolvedValue({ data: [{ url: POST_URL, status: 'indexed', document: resolved }] });

    const hydrated = await hydrate();

    // The service requested exactly the extracted URL.
    expect(resolveDocuments).toHaveBeenCalledTimes(1);
    expect(resolveDocuments).toHaveBeenCalledWith({ urls: [POST_URL] });
    expect(hydrated.documents).toEqual([resolved]);
  });

  it('never passes on an image the reader would load from the linked site', async () => {
    // Clarity serves its own copies; an image URL on any other origin would make
    // the reader's device fetch from the site itself, so it is dropped and the
    // card shows without it.
    const resolved: ClarityDocument = {
      id: 'doc-2',
      canonicalUrl: 'https://example.com/some-article?canonical=1',
      title: 'External image',
      description: 'A description',
      imageUrl: 'https://images.example.com/og-image.png',
      faviconUrl: 'https://example.com/favicon.ico',
      publisher: 'Example',
      type: 'article',
      indexedAt: new Date().toISOString(),
    } as ClarityDocument;
    resolveDocuments.mockResolvedValue({ data: [{ url: POST_URL, status: 'indexed', document: resolved }] });

    const hydrated = await hydrate();

    expect(hydrated.documents?.[0]?.title).toBe('External image');
    expect(hydrated.documents?.[0]).not.toHaveProperty('imageUrl');
    expect(hydrated.documents?.[0]).not.toHaveProperty('faviconUrl');
  });

  it('maps every resolved preview of a multi-link post, in text order', async () => {
    mockDocuments({
      [POST_URL]: resolvedPreview(POST_URL, 'First'),
      [SECOND_URL]: resolvedPreview(SECOND_URL, 'Second'),
    });

    const hydrated = await hydrate(`two links: ${SECOND_URL} and ${POST_URL}`);

    expect(resolveDocuments).toHaveBeenCalledWith({ urls: [SECOND_URL, POST_URL] });
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

  it('never asks Clarity to wait: a read takes what is resolved and moves on', async () => {
    // A `waitMs` here held every page with a not-yet-resolved link for the
    // whole wait — about 2s of each production search in issue #1140. Stored
    // posts are warmed at ingest and at creation; a reader never waits.
    resolveDocuments.mockResolvedValue({ data: [{ url: POST_URL, status: 'pending' }] });

    await hydrate();

    expect(resolveDocuments).toHaveBeenCalledTimes(1);
    expect(resolveDocuments.mock.calls[0][0]).not.toHaveProperty('waitMs');
  });

  it.each(['queued', 'discovered', 'fetching', 'extracted'])(
    'omits a %s document and marks the post pending, so the app asks again',
    async (status) => {
      resolveDocuments.mockResolvedValue({ data: [{ url: POST_URL, status }] });

      const hydrated = await hydrate();
      expect(hydrated.documents).toEqual([]);
      expect(hydrated.documentsPending).toBe(true);
    },
  );

  it.each(['failed', 'blocked', 'removed'])(
    'omits a %s document without marking the post pending: nobody retries it',
    async (status) => {
      resolveDocuments.mockResolvedValue({ data: [{ url: POST_URL, status }] });

      const hydrated = await hydrate();
      expect(hydrated.documents).toEqual([]);
      expect(hydrated).not.toHaveProperty('documentsPending');
    },
  );

  it('carries no pending flag once every card is resolved', async () => {
    mockDocuments({ [POST_URL]: resolvedPreview(POST_URL, 'First') });

    const hydrated = await hydrate();
    expect(hydrated.documents).toHaveLength(1);
    expect(hydrated).not.toHaveProperty('documentsPending');
  });

  it('keeps the resolved card and flags the post when only some links are pending', async () => {
    resolveDocuments.mockResolvedValue({ data: [
      { url: POST_URL, status: 'indexed', document: resolvedPreview(POST_URL, 'First') },
      { url: SECOND_URL, status: 'queued' },
    ] });

    const hydrated = await hydrate(`${POST_URL} ${SECOND_URL}`);
    expect(hydrated.documents?.map((preview) => preview.title)).toEqual(['First']);
    expect(hydrated.documentsPending).toBe(true);
  });

  it('matches a result Clarity echoed back canonicalised to the link that was asked for', async () => {
    // Clarity answers with `canonicalizePublicUrl(requested)`: the fragment
    // dropped, the host lower-cased. Matching on the echoed URL lost this card.
    const asked = 'https://Example.com/story#comments';
    resolveDocuments.mockImplementation(async ({ urls }: { urls: string[] }) => ({
      data: urls.map(() => ({
        url: 'https://example.com/story',
        status: 'indexed',
        document: resolvedPreview('https://example.com/story', 'Story'),
      })),
    }));

    const hydrated = await hydrate(`read ${asked}`);
    expect(resolveDocuments).toHaveBeenCalledWith({ urls: [asked] });
    expect(hydrated.documents?.map((preview) => preview.title)).toEqual(['Story']);
  });

  it('treats a missing batch result as pending', async () => {
    resolveDocuments.mockResolvedValue({ data: [] });

    const hydrated = await hydrate();
    expect(hydrated.documents).toEqual([]);
    expect(hydrated.documentsPending).toBe(true);
  });

  it('still hydrates the post when Clarity throws, and leaves its cards pending', async () => {
    resolveDocuments.mockRejectedValue(new Error('clarity down'));

    const hydrated = await hydrate();
    expect(hydrated).toBeTruthy();
    expect(hydrated.id).toBe(POST_ID);
    expect(hydrated.documents).toEqual([]);
    expect(hydrated.documentsPending).toBe(true);
  });

  it('passes a caller-supplied wait through to Clarity', async () => {
    mockDocuments({ [POST_URL]: resolvedPreview(POST_URL, 'First') });

    await service.hydratePosts([postRow()], {
      viewerId: undefined,
      maxDepth: 0,
      includeLinkMetadata: true,
      linkMetadataWaitMs: 3_000,
    });

    expect(resolveDocuments).toHaveBeenCalledWith({ urls: [POST_URL], waitMs: 3_000 });
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

  describe('the card a federated post arrived with (FEP-8967)', () => {
    const card = { url: POST_URL, title: 'Remote title', description: 'Remote description' };

    it('stands in for a link Clarity is still indexing, and settles the post', async () => {
      resolveDocuments.mockResolvedValue({ data: [{ url: POST_URL, status: 'queued' }] });
      findPostLinkPreviews.mockResolvedValue(new Map([[POST_ID, [card]]]));

      const hydrated = await hydrate();

      expect(findPostLinkPreviews).toHaveBeenCalledWith([POST_ID]);
      expect(hydrated.documents).toEqual([
        expect.objectContaining({ canonicalUrl: POST_URL, title: 'Remote title', description: 'Remote description' }),
      ]);
      // No remote image ever reaches the reader.
      expect(hydrated.documents?.[0]).not.toHaveProperty('imageUrl');
      expect(hydrated).not.toHaveProperty('documentsPending');
    });

    it('stands in for a link Clarity gave up on', async () => {
      resolveDocuments.mockResolvedValue({ data: [{ url: POST_URL, status: 'failed' }] });
      findPostLinkPreviews.mockResolvedValue(new Map([[POST_ID, [card]]]));

      expect((await hydrate()).documents?.map((doc) => doc.title)).toEqual(['Remote title']);
    });

    it('matches the card to the link however either was spelled', async () => {
      resolveDocuments.mockResolvedValue({ data: [{ url: 'https://Example.com/some-article', status: 'failed' }] });
      findPostLinkPreviews.mockResolvedValue(new Map([[POST_ID, [card]]]));

      const hydrated = await hydrate('look at this https://Example.com/some-article');
      expect(hydrated.documents?.map((doc) => doc.title)).toEqual(['Remote title']);
    });

    it('never replaces a document Clarity has, and is not even read for it', async () => {
      mockDocuments({ [POST_URL]: resolvedPreview(POST_URL, 'Clarity title') });
      findPostLinkPreviews.mockResolvedValue(new Map([[POST_ID, [card]]]));

      const hydrated = await hydrate();

      expect(hydrated.documents?.map((doc) => doc.title)).toEqual(['Clarity title']);
      expect(findPostLinkPreviews).not.toHaveBeenCalled();
    });

    it('ignores a card for a link the body does not carry', async () => {
      resolveDocuments.mockResolvedValue({ data: [{ url: POST_URL, status: 'queued' }] });
      findPostLinkPreviews.mockResolvedValue(new Map([[POST_ID, [{ ...card, url: 'https://elsewhere.example/' }]]]));

      const hydrated = await hydrate();
      expect(hydrated.documents).toEqual([]);
      expect(hydrated.documentsPending).toBe(true);
    });

    it('still hydrates when the stored cards cannot be read', async () => {
      resolveDocuments.mockResolvedValue({ data: [{ url: POST_URL, status: 'queued' }] });
      findPostLinkPreviews.mockRejectedValue(new Error('db down'));

      const hydrated = await hydrate();
      expect(hydrated.documents).toEqual([]);
      expect(hydrated.documentsPending).toBe(true);
    });
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
      expect(resolveDocuments).toHaveBeenCalledWith({ urls: [POST_URL] });
      expect(hydrated.documents?.map((preview) => preview.canonicalUrl)).toEqual([POST_URL]);
    });

    it('keeps the card for a profile URL on ANY OTHER host', async () => {
      // The renderer leaves these as links, because whether we hold that account
      // is not readable from the characters — so the card has to stay too.
      const remote = 'https://mastodon.social/@bob';
      mockDocuments({ [remote]: resolvedPreview(remote, 'Bob') });

      const hydrated = await hydrate(`mira ${remote}`);

      expect(resolveDocuments).toHaveBeenCalledWith({ urls: [remote] });
      expect(hydrated.documents?.map((preview) => preview.canonicalUrl)).toEqual([remote]);
    });

    it('keeps the card for one of our own pages that is not a profile', async () => {
      const ourPost = 'https://mention.earth/p/650000000000000000000099';
      mockDocuments({ [ourPost]: resolvedPreview(ourPost, 'A post') });

      const hydrated = await hydrate(`mira ${ourPost}`);

      expect(resolveDocuments).toHaveBeenCalledWith({ urls: [ourPost] });
      expect(hydrated.documents?.map((preview) => preview.canonicalUrl)).toEqual([ourPost]);
    });

    it('keeps the card for a sub-page of one of our profiles', async () => {
      const followers = 'https://mention.earth/@alice/followers';
      mockDocuments({ [followers]: resolvedPreview(followers, 'Followers') });

      const hydrated = await hydrate(`mira ${followers}`);

      expect(resolveDocuments).toHaveBeenCalledWith({ urls: [followers] });
      expect(hydrated.documents?.map((preview) => preview.canonicalUrl)).toEqual([followers]);
    });
  });
});
