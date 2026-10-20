import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { postContentVariants } from '../../db/schema/postContent';
import { clearServiceScope, seedPost, serviceScope } from '../helpers/serviceFixtures';
import { rewriteMirrorHostsInBodies } from '../../scripts/rewriteMirrorHostsInBodies';

const scope = serviceScope('mirror-host-backfill');
const BODY =
  'thanks [@@elonmusk@bird.makeup](https://bird.makeup/users/elonmusk) https://bird.makeup/users/a/statuses/1';
const FIXED = 'thanks [@@elonmusk@x.com](https://x.com/elonmusk) https://x.com/a/status/1';

async function seedBody(federated: boolean): Promise<string> {
  const record = await seedPost(scope, {
    content: { variants: [{ source: 'author', tag: 'en', text: BODY }] },
    ...(federated
      ? {
          federation: {
            actorUri: 'https://bird.makeup/users/someone',
            activityId: crypto.randomUUID(),
          },
        }
      : {}),
  });
  return record.id;
}

async function bodyOf(postId: string): Promise<string | undefined> {
  const [row] = await getDb()
    .select({ body: postContentVariants.body })
    .from(postContentVariants)
    .where(eq(postContentVariants.postId, postId));
  return row?.body;
}

beforeAll(connectPostgres);
afterEach(() => clearServiceScope(scope));
afterAll(closePostgres);

it('rewrites federated bodies only, and a dry run writes nothing', async () => {
  const federated = await seedBody(true);
  const local = await seedBody(false);
  const postIds = [federated, local];

  const dry = await rewriteMirrorHostsInBodies({ dryRun: true, postIds });
  expect(await bodyOf(federated)).toBe(BODY);
  expect(dry).toMatchObject({ changed: 1, written: 0 });

  const run = await rewriteMirrorHostsInBodies({ dryRun: false, postIds });
  expect(await bodyOf(federated)).toBe(FIXED);
  expect(await bodyOf(local)).toBe(BODY);
  expect(run).toMatchObject({ scanned: 1, changed: 1, written: 1 });

  expect(await rewriteMirrorHostsInBodies({ dryRun: false, postIds })).toMatchObject({
    scanned: 0,
  });
});
