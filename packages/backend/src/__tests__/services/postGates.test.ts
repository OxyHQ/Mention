/**
 * A post's reply and quote controls follow the post's own two gates: reading one
 * is an action on the post (the read gate), writing one is managing it.
 *
 * Both gates have their own suites, so they are reduced here to what a case
 * marks: `unreadable` posts fail the read gate, and only the post's author
 * passes management.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPostUri } from '@mention/shared-types';

const hoisted = vi.hoisted(() => ({ unreadable: new Set<string>() }));

vi.mock('../../services/postReadAccess', () => ({
  canRequestReadPost: vi.fn(
    async (_req: unknown, postId: string) => !hoisted.unreadable.has(postId),
  ),
}));
vi.mock('../../services/postManagementAccess', () => ({
  postManagementRefusal: vi.fn(
    async ({ post, callerId }: { post: { oxyUserId: string }; callerId: string }) =>
      post.oxyUserId === callerId ? null : { status: 404, message: 'Post not found' },
  ),
}));

import { inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { threadgates } from '../../db/schema/gates';
import { readThreadgate, removeThreadgate, writeThreadgate } from '../../services/postGates';
import { clearServiceScope, seedPost, serviceScope } from '../helpers/serviceFixtures';

const scope = serviceScope('post-gates');
const AUTHOR = scope.user('author');
const STRANGER = scope.user('stranger');
const postIds: string[] = [];

const as = (userId: string) => ({ user: { id: userId } }) as never;

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  hoisted.unreadable.clear();
  if (postIds.length > 0)
    await getDb()
      .delete(threadgates)
      .where(inArray(threadgates.postId, postIds.splice(0)));
  await clearServiceScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('post gates', () => {
  it("are written only by the post's manager, under the post's own URI", async () => {
    const post = await seedPost(scope, { oxyUserId: AUTHOR });
    postIds.push(post.id);
    const allow = { allow: [{ type: 'followingOnly' }] };

    expect(await writeThreadgate(as(STRANGER), post.id, allow)).toEqual({
      status: 404,
      body: { message: 'Post not found' },
    });
    expect(await readThreadgate(as(AUTHOR), post.id)).toMatchObject({ status: 404 });

    const written = await writeThreadgate(as(AUTHOR), post.id, allow);
    expect(written).toMatchObject({
      status: 200,
      body: { postUri: createPostUri(AUTHOR, post.id), createdBy: AUTHOR },
    });
    expect((await removeThreadgate(as(STRANGER), post.id)).status).toBe(404);
    expect((await readThreadgate(as(STRANGER), post.id)).status).toBe(200);
  });

  it('read on a post the viewer may not read answers as a post with no gate', async () => {
    const gated = await seedPost(scope, { oxyUserId: AUTHOR });
    const ungated = await seedPost(scope, { oxyUserId: AUTHOR });
    postIds.push(gated.id, ungated.id);
    await writeThreadgate(as(AUTHOR), gated.id, { allow: [] });
    hoisted.unreadable.add(gated.id);

    expect(await readThreadgate(as(STRANGER), gated.id)).toEqual(
      await readThreadgate(as(STRANGER), ungated.id),
    );
  });
});
