import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  postFind: vi.fn(),
  postUpdateOne: vi.fn(),
  persistRemoteMediaForFederatedOwner: vi.fn(),
  isMediaCacheEnabled: vi.fn(),
  recordAccessAndMaybeEnqueue: vi.fn(),
}));

vi.mock('../../models/Post', () => ({
  Post: {
    find: mocks.postFind,
    updateOne: mocks.postUpdateOne,
  },
}));

vi.mock('../../services/mediaCache/cacheWorker', () => ({
  persistRemoteMediaForFederatedOwner: mocks.persistRemoteMediaForFederatedOwner,
}));

vi.mock('../../services/mediaCache/oxyMediaStore', () => ({
  isMediaCacheEnabled: mocks.isMediaCacheEnabled,
}));

vi.mock('../../services/mediaCache/cacheStore', () => ({
  recordAccessAndMaybeEnqueue: mocks.recordAccessAndMaybeEnqueue,
}));

import { runFederatedMediaBackfillOnce } from '../../services/mediaCache/federatedMediaBackfill';

const query = {
  select: vi.fn(),
  sort: vi.fn(),
  limit: vi.fn(),
  lean: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();

  query.select.mockReturnValue(query);
  query.sort.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  query.lean.mockResolvedValue([]);

  mocks.postFind.mockReturnValue(query);
  mocks.postUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  mocks.persistRemoteMediaForFederatedOwner.mockResolvedValue({
    oxyFileId: 'oxy_file_default',
    contentType: 'image/png',
    sizeBytes: 1234,
  });
  mocks.isMediaCacheEnabled.mockReturnValue(true);
  mocks.recordAccessAndMaybeEnqueue.mockResolvedValue(true);
});

describe('runFederatedMediaBackfillOnce', () => {
  it('does nothing when durable media writes are disabled', async () => {
    mocks.isMediaCacheEnabled.mockReturnValue(false);

    const result = await runFederatedMediaBackfillOnce();

    expect(result).toEqual({
      scannedPosts: 0,
      updatedPosts: 0,
      convertedMedia: 0,
      failedMedia: 0,
      disabled: true,
    });
    expect(mocks.postFind).not.toHaveBeenCalled();
    expect(mocks.postUpdateOne).not.toHaveBeenCalled();
  });

  it('converts remote media ids to Oxy asset ids and keeps attachments in sync', async () => {
    query.lean.mockResolvedValue([
      {
        _id: 'post_1',
        oxyUserId: 'federated_user_1',
        federation: { activityId: 'https://remote.example/users/alice/statuses/1' },
        content: {
          media: [
            { id: 'https://remote.example/media/a.png', type: 'image' },
            { id: 'oxy_file_existing', type: 'image' },
          ],
          attachments: [
            { type: 'media', id: 'https://remote.example/media/a.png', mediaType: 'image' },
          ],
        },
      },
    ]);
    mocks.persistRemoteMediaForFederatedOwner.mockResolvedValue({
      oxyFileId: 'oxy_file_backfilled',
      posterFileId: 'oxy_file_poster',
      contentType: 'image/png',
      sizeBytes: 1234,
    });

    const result = await runFederatedMediaBackfillOnce();

    expect(mocks.postFind).toHaveBeenCalledWith({
      federation: { $ne: null },
      oxyUserId: { $type: 'string', $ne: '' },
      'content.media': { $elemMatch: { id: expect.any(RegExp) } },
    });
    expect(query.limit).toHaveBeenCalledWith(20);

    expect(mocks.persistRemoteMediaForFederatedOwner).toHaveBeenCalledWith(
      'https://remote.example/media/a.png',
      'federated_user_1',
      {
        remoteHost: 'remote.example',
        activityId: 'https://remote.example/users/alice/statuses/1',
        postId: 'post_1',
        mediaType: 'image',
        backfill: true,
      },
    );

    expect(mocks.postUpdateOne).toHaveBeenCalledTimes(1);
    const [, update] = mocks.postUpdateOne.mock.calls[0];
    expect(update.$set['content.media']).toEqual([
      {
        id: 'oxy_file_backfilled',
        type: 'image',
        remoteUrl: 'https://remote.example/media/a.png',
        cachedFromFederation: true,
        posterFileId: 'oxy_file_poster',
      },
      { id: 'oxy_file_existing', type: 'image' },
    ]);
    expect(update.$set['content.attachments']).toEqual([
      { type: 'media', id: 'oxy_file_backfilled', mediaType: 'image' },
    ]);
    expect(result).toEqual({
      scannedPosts: 1,
      updatedPosts: 1,
      convertedMedia: 1,
      failedMedia: 0,
      disabled: false,
    });
  });

  it('leaves a post untouched when the durable upload fails', async () => {
    query.lean.mockResolvedValue([
      {
        _id: 'post_2',
        oxyUserId: 'federated_user_2',
        federation: { activityId: 'https://remote.example/users/bob/statuses/2' },
        content: {
          media: [{ id: 'https://remote.example/media/b.png', type: 'image' }],
          attachments: [{ type: 'media', id: 'https://remote.example/media/b.png', mediaType: 'image' }],
        },
      },
    ]);
    mocks.persistRemoteMediaForFederatedOwner.mockResolvedValue(null);

    const result = await runFederatedMediaBackfillOnce();

    expect(mocks.postUpdateOne).not.toHaveBeenCalled();
    expect(mocks.recordAccessAndMaybeEnqueue).toHaveBeenCalledWith('https://remote.example/media/b.png');
    expect(result).toEqual({
      scannedPosts: 1,
      updatedPosts: 0,
      convertedMedia: 0,
      failedMedia: 1,
      disabled: false,
    });
  });
});
