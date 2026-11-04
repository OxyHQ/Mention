import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The `app.bsky.feed.post` Jetstream handler against real `posts` rows: a create
 * by a followed account is imported by its AT-URI (the import seam is mocked —
 * it is the AppView), a create by anyone else is not, and a delete removes the
 * stored post through the federated deletion cascade, whoever wrote it.
 */

const mocks = vi.hoisted(() => ({ importPostsByUri: vi.fn() }));

vi.mock('../../../connectors/atproto/post.mapper', () => ({
  importPostsByUri: mocks.importPostsByUri,
}));

import { eq } from 'drizzle-orm';
import { createPostJetstreamHandler } from '../../../connectors/atproto/jetstream/postHandler';
import type { JetstreamCommit } from '../../../connectors/atproto/jetstream/protocol';
import { closePostgres, connectPostgres, getDb } from '../../../db/postgres';
import { posts } from '../../../db/schema/posts';
import { clearFederationScope, federationScope, seedPost } from '../../helpers/federationFixtures';

const scope = federationScope('jetstream-post-handler');
const FOLLOWED = 'did:plc:jetstreamfollowed000000000';
const STRANGER = 'did:plc:jetstreamstranger00000000';

function commit(did: string, operation: 'create' | 'delete', rkey: string): JetstreamCommit {
  return {
    did,
    collection: 'app.bsky.feed.post',
    rkey,
    operation,
    uri: `at://${did}/app.bsky.feed.post/${rkey}`,
    cursor: 1,
    ...(operation === 'create' ? { record: { $type: 'app.bsky.feed.post' }, cid: 'bafy' } : {}),
  };
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.importPostsByUri.mockResolvedValue(1);
  await clearFederationScope(scope);
});

afterAll(async () => {
  await clearFederationScope(scope);
  await closePostgres();
});

describe('Jetstream post handler', () => {
  it('imports followed accounts’ new posts and applies every delete', async () => {
    const stored = await seedPost(scope, {
      oxyUserId: scope.user('stranger'),
      federation: { activityId: `at://${STRANGER}/app.bsky.feed.post/old`, actorUri: STRANGER },
    });
    const handler = createPostJetstreamHandler({ followedDids: async () => [FOLLOWED] });

    await handler.handle([
      commit(FOLLOWED, 'create', 'new'),
      commit(STRANGER, 'create', 'ignored'),
      commit(STRANGER, 'delete', 'old'),
      commit(STRANGER, 'delete', 'never-stored'),
    ]);

    expect(mocks.importPostsByUri).toHaveBeenCalledWith([
      `at://${FOLLOWED}/app.bsky.feed.post/new`,
    ]);
    const remaining = await getDb().select().from(posts).where(eq(posts.id, stored.id));
    expect(remaining).toHaveLength(0);
  });
});
