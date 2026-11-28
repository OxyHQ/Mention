// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { PostType } from '@mention/shared-types';
import { closePostgres, connectPostgres } from '../../db/postgres';
import { threadSlicingService } from '../../services/posts/ThreadSlicingService';
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
  const repostOfReply = await seedPost(scope, {
    oxyUserId: scope.user('nate'),
    type: PostType.REPOST,
    boostOf: reply.id,
  });
  const repostOfPost = await seedPost(scope, {
    oxyUserId: scope.user('nate'),
    type: PostType.REPOST,
    boostOf: parent.id,
  });

  const { slices, additionalPostIds } = await threadSlicingService.sliceFeed(
    [repostOfReply, repostOfPost] as never,
    { enableReplyContext: false },
  );

  expect(slices.map((slice) => ({ ids: slice._sliceKey, reason: slice.reason?.type }))).toEqual([
    { ids: `${parent.id}+${repostOfReply.id}`, reason: 'replyContext' },
    { ids: repostOfPost.id, reason: undefined },
  ]);
  expect(additionalPostIds).toEqual([parent.id]);
});
