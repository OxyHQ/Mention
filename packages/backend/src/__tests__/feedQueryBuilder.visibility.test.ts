import { describe, expect, it } from 'vitest';
import { PostVisibility } from '@mention/shared-types';
import { FeedQueryBuilder } from '../utils/feedQueryBuilder';

describe('FeedQueryBuilder feed publication filters', () => {
  it('requires following-feed posts, including replies, to be public and published', () => {
    const query = FeedQueryBuilder.buildFollowingQuery(['user-1']);

    expect(query).toMatchObject({
      oxyUserId: { $in: ['user-1'] },
      visibility: PostVisibility.PUBLIC,
      status: 'published',
    });
  });

  it('requires explore-feed posts to be public and published', () => {
    const query = FeedQueryBuilder.buildExploreQuery();

    expect(query).toMatchObject({
      visibility: PostVisibility.PUBLIC,
      status: 'published',
    });
  });
});
