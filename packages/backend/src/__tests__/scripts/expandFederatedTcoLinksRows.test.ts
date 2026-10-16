import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { postContentVariants } from '../../db/schema/postContent';
import { clearServiceScope, seedPost, serviceScope } from '../helpers/serviceFixtures';
import { expandFederatedTcoLinks } from '../../scripts/expandFederatedTcoLinks';

vi.mock('../../utils/safeUpstreamFetch', () => ({
  fetchUpstreamSingleHop: async (url: string) => ({
    response: { destroy: () => undefined },
    status: url === 'https://t.co/abc123' ? 301 : 404,
    headers: url === 'https://t.co/abc123' ? { location: 'https://example.com/' } : {},
  }),
}));

const scope = serviceScope('tco-link-backfill');
const BODY = 'read https://t.co/abc123';

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

  const dry = await expandFederatedTcoLinks({ dryRun: true, pauseMs: 0, postIds });
  expect(await bodyOf(federated)).toBe(BODY);
  expect(dry).toMatchObject({ changed: 1, written: 0 });

  const run = await expandFederatedTcoLinks({ dryRun: false, pauseMs: 0, postIds });
  expect(await bodyOf(federated)).toBe('read https://example.com/');
  expect(await bodyOf(local)).toBe(BODY);
  expect(run).toMatchObject({ scanned: 1, changed: 1, written: 1 });
});
