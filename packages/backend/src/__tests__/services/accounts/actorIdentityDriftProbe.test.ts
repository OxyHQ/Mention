import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The refresh fast path of `reconcileActorIdentityProjection` answers "already
 * projected" only when NO post of the source carries another `oxy_user_id`. Its
 * probe is three index seeks (`<`, `>`, `is null`) instead of a walk of every
 * entry; each half must still see the drift it exists for.
 */
vi.mock('../../../services/accounts/userSummaryCache', () => ({ invalidate: vi.fn() }));
vi.mock('../../../services/feed/anonFeedStaleMarker', () => ({
  markAnonymousFeedsStale: vi.fn(),
}));

import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../../db/postgres';
import { posts } from '../../../db/schema/posts';
import { reconcileActorIdentityProjection } from '../../../services/accounts/ActorIdentityProjectionService';
import {
  clearFederationScope,
  federationScope,
  seedActor,
  seedPost,
} from '../../helpers/federationFixtures';

const scope = federationScope('actor-drift-probe');
// Ids either side of PROJECTED, so both range seeks are exercised.
const PROJECTED = scope.user('m');
const BELOW = scope.user('a');
const ABOVE = scope.user('z');

async function sourceWith(owners: readonly (string | null)[]) {
  const actor = await seedActor(scope, { oxyUserId: PROJECTED });
  const ids: string[] = [];
  for (const owner of owners) {
    const post = await seedPost(scope, {
      oxyUserId: owner ?? PROJECTED,
      federation: { actorUri: actor.uri },
    } as Parameters<typeof seedPost>[1]);
    if (owner === null) {
      await getDb().execute(sql`update posts set oxy_user_id = null where id = ${post.id}`);
    }
    ids.push(post.id);
  }
  return { actorUri: actor.uri, ids };
}

async function ownerOf(id: string) {
  const [row] = await getDb()
    .select({ oxyUserId: posts.oxyUserId })
    .from(posts)
    .where(eq(posts.id, id));
  return row?.oxyUserId ?? null;
}

beforeAll(connectPostgres);
afterEach(() => clearFederationScope(scope));
afterAll(closePostgres);

describe('actor identity refresh drift probe', () => {
  it('answers unchanged when every post already carries the projected id', async () => {
    const { actorUri } = await sourceWith([PROJECTED, PROJECTED]);
    const result = await reconcileActorIdentityProjection({
      actorUri,
      oxyUserId: PROJECTED,
      check: 'refresh',
    });
    expect(result).toMatchObject({ actorChanged: false, postsChanged: 0 });
  });

  it.each([
    ['a lower id', BELOW],
    ['a higher id', ABOVE],
    ['no id', null],
  ])('sees a post carrying %s and projects it', async (_label, owner) => {
    const { actorUri, ids } = await sourceWith([PROJECTED, owner]);
    const result = await reconcileActorIdentityProjection({
      actorUri,
      oxyUserId: PROJECTED,
      check: 'refresh',
    });
    expect(result.postsChanged).toBe(1);
    expect(await ownerOf(ids[1])).toBe(PROJECTED);
  });
});
