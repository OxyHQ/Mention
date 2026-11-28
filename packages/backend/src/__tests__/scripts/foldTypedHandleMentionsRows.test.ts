import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { postContentVariants, postMentions } from '../../db/schema/postContent';
import { clearFederationScope, federationScope, seedActor } from '../helpers/federationFixtures';
import { clearServiceScope, seedPost, serviceScope } from '../helpers/serviceFixtures';
import { foldTypedHandleMentions } from '../../scripts/foldTypedHandleMentions';

const posts = serviceScope('fold-typed-handles');
const actors = federationScope('fold-typed-handles');

beforeAll(connectPostgres);
afterEach(async () => {
  await clearServiceScope(posts);
  await clearFederationScope(actors);
});
afterAll(closePostgres);

it('folds a handle typed by its network spelling, and a dry run writes nothing', async () => {
  await seedActor(actors, {
    username: 'cloudflare',
    oxyUserId: 'oxy-cloudflare',
    networkAcct: 'cloudflare@x.example',
  });
  const { id } = await seedPost(posts, {
    content: { variants: [{ source: 'author', tag: 'en', text: 'thanks @Cloudflare@x.example!' }] },
  });
  const bodyOf = async () =>
    (
      await getDb()
        .select({ body: postContentVariants.body })
        .from(postContentVariants)
        .where(eq(postContentVariants.postId, id))
    )[0]?.body;

  expect(await foldTypedHandleMentions({ dryRun: true, postIds: [id] })).toMatchObject({
    folded: 1,
    mentionsAdded: 1,
  });
  expect(await bodyOf()).toBe('thanks @Cloudflare@x.example!');

  await foldTypedHandleMentions({ dryRun: false, postIds: [id] });
  expect(await bodyOf()).toBe('thanks [mention:oxy-cloudflare]!');
  const rows = await getDb().select().from(postMentions).where(eq(postMentions.postId, id));
  expect(rows.map((row) => row.oxyUserId)).toEqual(['oxy-cloudflare']);
});
