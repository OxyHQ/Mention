import { describe, it, expect } from 'vitest';
import { UserFeedPreference } from '../../models/UserFeedPreference';

/**
 * UserFeedPreference model — a viewer's persisted feed layout. No DB (mongoose is
 * mocked in setup); these instantiate a real document and assert the schema
 * shape (subdocs carry no `_id`) + the unique index on `oxyUserId`.
 */

describe('UserFeedPreference schema', () => {
  it('round-trips a savedFeeds layout with no subdoc _id', async () => {
    const doc = new UserFeedPreference({
      oxyUserId: 'u1',
      savedFeeds: [
        { key: 'for_you', descriptor: 'for_you', pinned: true, order: 0 },
        { key: 'following', descriptor: 'following', pinned: true, order: 1 },
      ],
    });
    await doc.validate();
    const obj = doc.toObject();
    expect(obj.savedFeeds).toHaveLength(2);
    expect(obj.savedFeeds[0]).toMatchObject({ key: 'for_you', descriptor: 'for_you', pinned: true, order: 0 });
    expect((obj.savedFeeds[0] as unknown as Record<string, unknown>)._id).toBeUndefined();
  });

  it('defaults savedFeeds to an empty array', () => {
    const doc = new UserFeedPreference({ oxyUserId: 'u2' });
    expect(doc.savedFeeds).toEqual([]);
  });

  it('declares a unique index on oxyUserId', () => {
    const indexes = UserFeedPreference.schema.indexes();
    const unique = indexes.find(([key, opts]) => (key as Record<string, unknown>).oxyUserId === 1 && opts?.unique);
    expect(unique).toBeDefined();
  });
});
