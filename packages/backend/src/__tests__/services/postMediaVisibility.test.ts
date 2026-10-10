import { describe, expect, it, vi } from 'vitest';

const warn = vi.hoisted(() => vi.fn());
vi.mock('../../utils/logger', () => ({
  logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const createUserScopedOxyServices = vi.hoisted(() => vi.fn());
vi.mock('../../utils/oxyHelpers', () => ({ createUserScopedOxyServices }));

import {
  POST_MEDIA_VISIBILITY_TIMEOUT_MS,
  createPostMediaOwnerClient,
  ensurePostMediaPublic,
  postMediaFileIds,
} from '../../services/postMediaVisibility';

function fakeClient(setVisibility = vi.fn().mockResolvedValue({ file: {} })) {
  return { assets: { setVisibility } } as unknown as Parameters<typeof ensurePostMediaPublic>[0] & {
    assets: { setVisibility: typeof setVisibility };
  };
}

describe('postMediaFileIds', () => {
  it('collects shared media, variant replacement media and variant alt keys, deduped', () => {
    const ids = postMediaFileIds({
      text: 'hola',
      media: [
        { id: 'video-1', type: 'video' },
        { id: 'image-1', type: 'image' },
      ],
      variants: [
        {
          source: 'author',
          language: 'es',
          text: 'hola',
          media: [{ id: 'image-es', type: 'image' }],
        },
        { source: 'author', language: 'en', text: 'hi', alt: { 'image-1': 'A cat' } },
        {
          source: 'machine',
          language: 'fr',
          text: 'salut',
          media: [{ id: 'machine-only', type: 'image' }],
        },
      ],
    } as never);
    expect(ids.sort()).toEqual(['image-1', 'image-es', 'video-1']);
  });

  it('skips temp ids and absolute URLs, which have no Oxy visibility', () => {
    const ids = postMediaFileIds({
      media: [
        { id: 'temp-123', type: 'image' },
        { id: 'https://files.example/cat.jpg', type: 'image' },
        { id: 'real-1', type: 'image' },
      ],
    } as never);
    expect(ids).toEqual(['real-1']);
  });

  it('is empty for a post without media', () => {
    expect(postMediaFileIds({ text: 'just words' } as never)).toEqual([]);
    expect(postMediaFileIds(undefined)).toEqual([]);
  });
});

describe('ensurePostMediaPublic', () => {
  it('makes every media file of the post public', async () => {
    const client = fakeClient();
    await ensurePostMediaPublic(client, {
      media: [
        { id: 'video-1', type: 'video' },
        { id: 'image-1', type: 'image' },
      ],
    } as never);
    expect(client.assets.setVisibility).toHaveBeenCalledTimes(2);
    expect(client.assets.setVisibility).toHaveBeenCalledWith('video-1', 'public');
    expect(client.assets.setVisibility).toHaveBeenCalledWith('image-1', 'public');
  });

  it('does nothing without a session client (an MCP caller uploads public already)', async () => {
    await expect(
      ensurePostMediaPublic(undefined, { media: [{ id: 'video-1', type: 'video' }] } as never),
    ).resolves.toBeUndefined();
  });

  it('never fails the write: a refused file is logged and the rest still go public', async () => {
    const setVisibility = vi
      .fn()
      .mockImplementation((id: string) =>
        id === 'not-mine' ? Promise.reject(new Error('Forbidden')) : Promise.resolve({ file: {} }),
      );
    const client = fakeClient(setVisibility);
    await expect(
      ensurePostMediaPublic(client, {
        media: [
          { id: 'not-mine', type: 'image' },
          { id: 'mine', type: 'image' },
        ],
      } as never),
    ).resolves.toBeUndefined();
    expect(setVisibility).toHaveBeenCalledWith('mine', 'public');
    expect(warn).toHaveBeenCalledWith(
      '[postMediaVisibility] Failed to make post media public',
      expect.objectContaining({ fileId: 'not-mine', error: 'Forbidden' }),
    );
  });
});

describe('createPostMediaOwnerClient', () => {
  it("uses the author's session with room for Oxy to move a long video's variants", () => {
    const req = { accessToken: 'author-token' };
    createPostMediaOwnerClient(req as never);
    expect(createUserScopedOxyServices).toHaveBeenCalledWith(req, {
      requestTimeout: POST_MEDIA_VISIBILITY_TIMEOUT_MS,
    });
    // The SDK default is 5s; a relocation of a few-minute video took longer.
    expect(POST_MEDIA_VISIBILITY_TIMEOUT_MS).toBeGreaterThan(5_000);
  });
});
