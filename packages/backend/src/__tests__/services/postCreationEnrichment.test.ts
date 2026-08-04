import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

const { getLinkPreviews, getUserById } = vi.hoisted(() => ({
  getLinkPreviews: vi.fn(),
  getUserById: vi.fn(),
}));

/**
 * The post is a REAL row. `PostCreationService.create` writes through the
 * repository now, so the `new Post(...)` double this replaces intercepted
 * nothing — every case here would have died on an absent connection rather than
 * on the enrichment it is about.
 */
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

import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearServiceScope, serviceScope } from '../helpers/serviceFixtures';
import { postCreationService } from '../../services/PostCreationService';
import { PostVisibility } from '@mention/shared-types';

const scope = serviceScope('post-creation-enrichment');

const ARTICLE_URL = 'https://example.com/a-federated-article';

/** The URLs the enrichment batch warm was asked to resolve, across all calls. */
function warmedUrls(): string[] {
  return getLinkPreviews.mock.calls.flatMap(([urls]) => urls as string[]);
}

/** Let the detached (un-awaited) enrichment settle before asserting on it. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * The params an AP inbox `Create` / atproto import hands the shared route.
 *
 * The activity id is unique PER CALL. `posts.federation_activity_id` carries a
 * unique constraint — which is the import's own dedupe — so reusing one literal
 * across cases makes the second create a duplicate-key error rather than the
 * enrichment the case is about.
 */
let federatedSeq = 0;
function federatedCreateParams(text: string) {
  federatedSeq += 1;
  const activityId = `https://mastodon.social/users/alice/statuses/${scope.name}-${federatedSeq}`;
  return {
    oxyUserId: scope.user('remote-author'),
    federation: {
      activityId,
      actorUri: 'https://mastodon.social/users/alice',
      url: activityId,
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

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
  getUserById.mockResolvedValue({ id: scope.user('remote-author'), username: 'alice' });
  getLinkPreviews.mockResolvedValue({});
});

afterEach(async () => {
  await clearServiceScope(scope);
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
      oxyUserId: scope.user('local-author'),
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
      oxyUserId: scope.user('local-author'),
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
