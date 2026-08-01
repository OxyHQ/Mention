import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `PostCreationService` runs the converged post-ingest enrichment for the posts
 * it stores.
 *
 * This is the NATIVE storage route (and the single-post federated imports that
 * share it: the ActivityPub inbox `Create` and the atproto author-feed import).
 * The federated backfill's raw-insert route is covered by
 * `connectors/activitypub/federatedPostEnrichment.test.ts`, and the parity
 * between the two by `services/postEnrichmentParity.test.ts`.
 *
 * The federated cases matter on their own because a federated body arrives as
 * `content.variants` rather than `content.text`: enrichment reads the post's
 * PRIMARY VARIANT, so a regression that only read `content.text` would keep
 * working for native posts and silently enrich nothing for every federated one.
 *
 * These pin:
 *   - a federated post whose body carries a link is enriched;
 *   - a federated post whose body carries no link warms nothing;
 *   - a native post whose body carries a link is enriched;
 *   - a SCHEDULED post is not enriched while it is scheduled, and IS enriched
 *     when it is published — the gap that left every scheduled post without a
 *     link preview, because `create` skipped the warm while unpublished and the
 *     publish step never ran one;
 *   - enrichment is DETACHED — a preview service that rejects never fails create.
 */

const { getLinkPreviews, getUserById, MockPost, postFindLean } = vi.hoisted(() => {
  class HoistedMockPost {
    [key: string]: unknown;
    constructor(data: Record<string, unknown>) {
      Object.assign(this, data);
    }
    save = vi.fn().mockResolvedValue(undefined);
    markModified = vi.fn();
    toObject(): Record<string, unknown> {
      return { ...this };
    }
    _id = 'mock_post_id';
  }
  return {
    getLinkPreviews: vi.fn(),
    getUserById: vi.fn(),
    MockPost: HoistedMockPost,
    postFindLean: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('../../models/Post', async () => {
  const actual = await vi.importActual<typeof import('../../models/Post')>('../../models/Post');
  return {
    POST_CLASSIFICATION_PENDING: actual.POST_CLASSIFICATION_PENDING,
    Post: Object.assign(MockPost, {
      find: () => ({ select: () => ({ lean: () => postFindLean() }) }),
    }),
  };
});

vi.mock('../../utils/notificationUtils', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
  createMentionNotifications: vi.fn().mockResolvedValue(undefined),
  createBatchNotifications: vi.fn().mockResolvedValue(undefined),
  createPostAuthorNotifications: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../models/PostSubscription', () => ({
  default: { find: () => ({ lean: () => Promise.resolve([]) }) },
}));

vi.mock('../../services/serviceRegistry', () => ({
  getPostFederator: () => ({ federateNewPost: vi.fn().mockResolvedValue(undefined) }),
  registerPostCreator: vi.fn(),
}));

// Mocked to a no-op so importing PostCreationService does not pull in the heavy
// `../../server` module graph via the socket-emit hydration path.
vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn().mockResolvedValue([]) },
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getUserById,
    getUsersByIds: vi.fn().mockResolvedValue([]),
    getLinkPreviews,
  }),
}));

import { postCreationService } from '../../services/PostCreationService';
import { PostVisibility } from '@mention/shared-types';

const ARTICLE_URL = 'https://example.com/a-federated-article';

/** The URLs the enrichment batch warm was asked to resolve, across all calls. */
function warmedUrls(): string[] {
  return getLinkPreviews.mock.calls.flatMap(([urls]) => urls as string[]);
}

/** Let the detached (un-awaited) enrichment settle before asserting on it. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** The params an AP inbox `Create` / atproto import hands the shared route. */
function federatedCreateParams(text: string) {
  return {
    oxyUserId: 'oxy_remote_author',
    federation: {
      activityId: 'https://mastodon.social/users/alice/statuses/1',
      actorUri: 'https://mastodon.social/users/alice',
      url: 'https://mastodon.social/users/alice/statuses/1',
      sensitive: false,
    },
    // A federated body's ONLY home is the variants array — never `content.text`.
    content: { variants: [{ source: 'author' as const, text }] },
    visibility: PostVisibility.PUBLIC,
    status: 'published' as const,
    skipNotifications: true,
    skipSocketEmit: true,
    skipFederationDelivery: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getUserById.mockResolvedValue({ id: 'oxy_remote_author', username: 'alice' });
  getLinkPreviews.mockResolvedValue({});
  postFindLean.mockResolvedValue([]);
});

describe('PostCreationService — post-ingest enrichment', () => {
  it('enriches a FEDERATED post from the link in its primary variant', async () => {
    await postCreationService.create(federatedCreateParams(`Read this ${ARTICLE_URL} today`));
    await settle();

    expect(warmedUrls()).toEqual([ARTICLE_URL]);
  });

  it('warms nothing for a FEDERATED post whose body carries no link', async () => {
    await postCreationService.create(federatedCreateParams('Just some words, no link at all.'));
    await settle();

    expect(getLinkPreviews).not.toHaveBeenCalled();
  });

  it('enriches a NATIVE post from the link in its text', async () => {
    await postCreationService.create({
      oxyUserId: 'oxy_local_author',
      content: { text: `look at ${ARTICLE_URL}` },
      visibility: PostVisibility.PUBLIC,
      skipSocketEmit: true,
    });
    await settle();

    expect(warmedUrls()).toEqual([ARTICLE_URL]);
  });

  it('creates the post even when the preview service rejects', async () => {
    getLinkPreviews.mockRejectedValue(new Error('preview service down'));

    const post = await postCreationService.create(
      federatedCreateParams(`Read this ${ARTICLE_URL} today`),
    );
    await settle();

    expect(post).toBeTruthy();
    expect(warmedUrls()).toEqual([ARTICLE_URL]);
  });
});

describe('PostCreationService — a scheduled post is enriched when it publishes', () => {
  /** Create a post that is scheduled, not yet published. */
  function createScheduled() {
    return postCreationService.create({
      oxyUserId: 'oxy_local_author',
      content: { text: `look at ${ARTICLE_URL}` },
      visibility: PostVisibility.PUBLIC,
      status: 'scheduled',
      scheduledFor: new Date(Date.now() + 60_000),
      skipSocketEmit: true,
    });
  }

  it('does NOT enrich while the post is still scheduled', async () => {
    await createScheduled();
    await settle();

    // Nobody can read it yet, so there is nothing to warm a preview for.
    expect(getLinkPreviews).not.toHaveBeenCalled();
  });

  it('enriches when the scheduler publishes it', async () => {
    const post = await createScheduled();
    await settle();
    expect(getLinkPreviews).not.toHaveBeenCalled();

    await postCreationService.publishScheduledPost(post);
    await settle();

    // The gap this pins: before the enrichment converged, `create` skipped the
    // warm because the post was unpublished and `publishScheduledPost` never ran
    // one — so a scheduled post never got a link preview at all.
    expect(warmedUrls()).toEqual([ARTICLE_URL]);
  });
});
