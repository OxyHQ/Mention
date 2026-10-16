import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaItem } from '@mention/shared-types';
const { access, setAccessToken } = vi.hoisted(() => ({ access: vi.fn(), setAccessToken: vi.fn() }));
vi.mock('@oxy.so/core', () => ({
  OxyServices: class {
    session = { setAccessToken };
    assets = { access };
  },
}));
import { hydratePostMedia } from '../../services/hydratePostMedia';
beforeEach(() => {
  vi.clearAllMocks();
});
const media = (id: string): MediaItem => ({
  id,
  type: 'image',
  url: `https://public.test/${id}`,
  thumbUrl: `https://public.test/${id}?variant=thumb`,
  posterUrl: `https://public.test/${id}?variant=poster`,
  hlsUrl: `https://public.test/${id}?variant=hls`,
});

describe('canonical asset access for a hydrated graph', () => {
  it('deduplicates the graph, scopes to the original viewer, and removes denied public fallbacks', async () => {
    const privateMedia = media('private-file');
    const publicMedia = media('public-file');
    const duplicate = media('private-file');
    const post = {
      content: { media: [privateMedia, publicMedia, media('denied-file')] },
      attachments: { media: [duplicate] },
    };
    access.mockResolvedValue({
      results: {
        'private-file': {
          allowed: true,
          visibility: 'private',
          url: 'https://oxy.test/scoped-media',
        },
        'public-file': {
          allowed: true,
          visibility: 'public',
          url: 'https://public.test/public-file',
        },
        'denied-file': { allowed: false, error: 'Access denied' },
      },
    });
    await hydratePostMedia([post], { accessToken: 'original-adult-contact' });
    expect(setAccessToken).toHaveBeenCalledWith('original-adult-contact');
    expect(access).toHaveBeenCalledTimes(1);
    expect(access.mock.calls[0][0]).toEqual([
      { fileId: 'private-file' },
      { fileId: 'public-file' },
      { fileId: 'denied-file' },
    ]);
    expect(post.content.media.map((item) => item.id)).toEqual(['private-file', 'public-file']);
    expect(privateMedia.url).toBe('https://oxy.test/scoped-media');
    expect(privateMedia).not.toHaveProperty('thumbUrl');
    expect(privateMedia).not.toHaveProperty('posterUrl');
    expect(privateMedia).not.toHaveProperty('hlsUrl');
    expect(duplicate.url).toBe(privateMedia.url);
    expect(publicMedia.thumbUrl).toContain('variant=thumb');
  });
  it('asks no session ACL for a reader without a session and never substitutes service identity', async () => {
    for (const requester of [{ connectionToken: 'adult-mcp-proof' }, { accessToken: null }]) {
      const stored = media('stored-file');
      const post = { content: { media: [stored] }, attachments: {} };
      await hydratePostMedia([post], requester);
      expect(post.content.media).toEqual([stored]);
    }
    expect(setAccessToken).not.toHaveBeenCalled();
    expect(access).not.toHaveBeenCalled();
  });
  it('bounds 201 unique files to three calls and refuses an authority outage', async () => {
    access.mockResolvedValue({ results: {} });
    await hydratePostMedia(
      [
        {
          content: { media: Array.from({ length: 201 }, (_, i) => media(String(i))) },
          attachments: {},
        },
      ],
      { accessToken: 'viewer' },
    );
    expect(access.mock.calls.map(([batch]) => batch.length)).toEqual([100, 100, 1]);
    access.mockRejectedValueOnce(new Error('Oxy unavailable'));
    await expect(
      hydratePostMedia([{ content: { media: [media('file')] }, attachments: {} }], {
        accessToken: 'viewer',
      }),
    ).rejects.toThrow('Oxy unavailable');
  });
});
