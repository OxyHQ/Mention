import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { PostType } from '@mention/shared-types';
import { closePostgres, connectPostgres } from '../../db/postgres';
import { threadSlicingService } from '../../services/ThreadSlicingService';
import { clearServiceScope, seedPost, serviceScope } from '../helpers/serviceFixtures';

/**
 * A boost of a reply is sliced as `[parent, boost]` under `replyContext` — the
 * boost is the subject, the parent its context — on every feed, including those
 * that do not thread their own replies (`enableReplyContext: false`, the profile).
 */

const scope = serviceScope('thread-slicing-boosted-reply');

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  await clearServiceScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

it('prepends the boosted reply’s parent, and leaves a boosted top-level post alone', async () => {
  const parent = await seedPost(scope, { oxyUserId: scope.user('borja') });
  const reply = await seedPost(scope, {
    oxyUserId: scope.user('nate'),
    isReply: true,
    parentPostId: parent.id,
  });
  const boostOfReply = await seedPost(scope, {
    oxyUserId: scope.user('nate'),
    type: PostType.BOOST,
    boostOf: reply.id,
  });
  const boostOfPost = await seedPost(scope, {
    oxyUserId: scope.user('nate'),
    type: PostType.BOOST,
    boostOf: parent.id,
  });

  const { slices, additionalPostIds } = await threadSlicingService.sliceFeed(
    [boostOfReply, boostOfPost] as never,
    { enableReplyContext: false },
  );

  expect(slices.map((slice) => ({ ids: slice._sliceKey, reason: slice.reason?.type }))).toEqual([
    { ids: `${parent.id}+${boostOfReply.id}`, reason: 'replyContext' },
    { ids: boostOfPost.id, reason: undefined },
  ]);
  expect(additionalPostIds).toEqual([parent.id]);
});
