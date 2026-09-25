import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Imported posts federate by PULL, with their ORIGINAL date.
 *
 * The import never pushes a post to anyone's inbox (`skipFederationDelivery`),
 * so the outbox is the only way the fediverse learns an imported post exists —
 * and a remote server that backfills it must file it where it was written, not
 * on top of today's timeline. This drives the real import service into real
 * rows and reads them back through the real outbox route and the real Note
 * builder, asserting `published` is the original `createdAt`.
 *
 * Mocked: the Oxy user lookup the route and the create path make, the network
 * pieces the connector would otherwise load (key store, delivery queue), and
 * the create path's own network boundaries (media, Clarity, MTN).
 */

const AP_ACCEPT = 'application/activity+json';

const mocks = vi.hoisted(() => ({
  resolveOxyUser: vi.fn(),
  getUserById: vi.fn(),
  enqueueDelivery: vi.fn(),
}));

vi.mock('express-rate-limit', () => ({
  default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../../middleware/rateLimitStore', () => ({ RedisStore: class {} }));
vi.mock('../../../queue/producers', () => ({
  enqueueDelivery: mocks.enqueueDelivery,
  enqueueInboxActivity: vi.fn(),
}));
vi.mock('../../../connectors/activitypub/actor.service', () => ({ actorService: {} }));
vi.mock('../../../connectors/activitypub/crypto', () => ({ getPublicKey: vi.fn(), signRequest: vi.fn() }));
vi.mock('../../../utils/safeUpstreamFetch', () => ({ fetchUpstreamSingleHop: vi.fn() }));
vi.mock('../../../connectors/activitypub/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../connectors/activitypub/constants')>();
  return { ...actual, resolveOxyUser: (...args: unknown[]) => mocks.resolveOxyUser(...args) };
});
vi.mock('../../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getUserById: mocks.getUserById,
    getUsersByIds: vi.fn().mockResolvedValue([]),
    getServiceAssetMetadataByIds: vi.fn().mockResolvedValue([]),
  }),
}));
vi.mock('../../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn().mockResolvedValue([]) },
}));
vi.mock('../../../utils/clarityClient', () => ({
  getClarityClient: async () => ({ indexing: { resolve: vi.fn().mockResolvedValue({ documents: [] }) } }),
}));
vi.mock('../../../services/mtn/MentionRecordEmitter', () => ({
  emitPostCreated: vi.fn(),
  emitRepostCreated: vi.fn(),
  emitTombstone: vi.fn(),
  postRecordUri: (author: string, id: string) => `mtn://${author}/${id}`,
}));

import { closePostgres, connectPostgres } from '../../../db/postgres';
import { clearServiceScope, serviceScope, trackPost } from '../../helpers/serviceFixtures';
import apRoutes from '../../../connectors/activitypub/routes/ap.routes';
import { postImportService } from '../../../services/PostImportService';
import { PostVisibility } from '@mention/shared-types';

const scope = serviceScope('imported-outbox');
const ALICE = scope.user('alice');

const app = express();
app.use('/ap', apRoutes);

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearServiceScope(scope);
  mocks.resolveOxyUser.mockResolvedValue({ _id: ALICE, username: 'alice', name: { displayName: 'Alice' } });
  mocks.getUserById.mockResolvedValue({ id: ALICE, username: 'alice' });
});

afterEach(async () => {
  await clearServiceScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('the ActivityPub outbox of an account with imported posts', () => {
  it('serves each imported root post with its ORIGINAL date as `published`, and pushed nothing', async () => {
    const results = await postImportService.ingestBatch({
      oxyUserId: ALICE,
      platform: 'mastodon',
      batchId: `${scope.name}-batch`,
      items: [
        {
          sourceId: 'old-1',
          sourceUrl: 'https://mastodon.example/@alice/1',
          createdAt: new Date('2018-06-01T10:00:00.250Z'),
          text: 'my first toot',
          visibility: PostVisibility.PUBLIC,
          media: [],
        },
        {
          sourceId: 'old-2',
          sourceUrl: 'https://mastodon.example/@alice/2',
          createdAt: new Date('2019-02-03T04:05:06.000Z'),
          text: 'a later toot',
          visibility: PostVisibility.PUBLIC,
          media: [],
        },
      ],
    });
    for (const result of results) if (result.postId) trackPost(scope, result.postId);
    expect(results.map((result) => result.status)).toEqual(['created', 'created']);

    // Nothing was delivered anywhere: no delivery job for the import itself.
    expect(mocks.enqueueDelivery).not.toHaveBeenCalled();

    const res = await request(app)
      .get('/ap/users/alice/outbox?page=true')
      .set('Accept', AP_ACCEPT)
      .expect(200);

    const byNoteId = new Map<string, Record<string, unknown>>();
    for (const activity of res.body.orderedItems as Array<{ object: Record<string, unknown> }>) {
      byNoteId.set(String(activity.object.id), activity.object);
    }
    const published = [...byNoteId.values()].map((note) => note.published).sort();
    expect(published).toEqual(['2018-06-01T10:00:00.250Z', '2019-02-03T04:05:06.000Z']);
    // Newest first, like every outbox page — the original dates decide the order.
    expect(res.body.orderedItems[0].object.published).toBe('2019-02-03T04:05:06.000Z');
    expect(res.body.totalItems).toBe(2);
  });
});
