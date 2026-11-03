import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ signedFetch: vi.fn() }));

vi.mock('../../../connectors/activitypub/helpers', async (importActual) => ({
  ...(await importActual<typeof import('../../../connectors/activitypub/helpers')>()),
  signedFetch: mocks.signedFetch,
}));

import { eq } from 'drizzle-orm';
import { outboxSyncService } from '../../../connectors/activitypub/outbox.service';
import { closePostgres, connectPostgres, getDb } from '../../../db/postgres';
import { posts } from '../../../db/schema/posts';
import { clearFederationScope, federationScope, seedPost } from '../../helpers/federationFixtures';

/** An actor's pinned posts arrive as its `featured` collection. */
const scope = federationScope('featured-post-sync');
const ACTOR = 'https://social.example/users/alice';
const NOTE = `${ACTOR}/statuses/1`;

const collection = (orderedItems: unknown[]) => ({
  ok: true,
  status: 200,
  json: async () => ({ type: 'OrderedCollection', totalItems: orderedItems.length, orderedItems }),
});
const pinned = (id: string) =>
  getDb()
    .select({ pinned: posts.metadataIsPinned })
    .from(posts)
    .where(eq(posts.id, id))
    .then(([row]) => row?.pinned);

beforeAll(async () => {
  await connectPostgres();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await clearFederationScope(scope);
});
afterAll(async () => {
  await closePostgres();
});

describe('OutboxSyncService.syncFeaturedPost', () => {
  it('pins the first featured note, and clears the pin once the collection is empty', async () => {
    const author = scope.user('alice');
    const note = await seedPost(scope, {
      oxyUserId: author,
      federation: { activityId: NOTE, actorUri: ACTOR },
    });
    const ensure = vi
      .spyOn(
        outboxSyncService as unknown as {
          ensureFederatedNote: (uri: string, reason: string) => Promise<string | null>;
        },
        'ensureFederatedNote',
      )
      .mockResolvedValue(note.id);
    const actor = { uri: ACTOR, featuredUrl: `${ACTOR}/collections/featured`, oxyUserId: author };

    mocks.signedFetch.mockResolvedValue(collection([{ id: NOTE, type: 'Note' }]));
    await outboxSyncService.syncFeaturedPost(actor);
    expect(ensure).toHaveBeenCalledWith(NOTE, 'requested_profile');
    expect(await pinned(note.id)).toBe(true);

    mocks.signedFetch.mockResolvedValue(collection([]));
    await outboxSyncService.syncFeaturedPost(actor);
    expect(await pinned(note.id)).toBe(false);
  });
});
