import { Dimensions, PixelRatio } from 'react-native';
import type { HydratedPost } from '@mention/shared-types';

jest.mock('@/lib/oxyServices', () => ({
  oxyServices: {
    cloudURL: 'https://cloud.oxy.so',
    assets: {
      renderUrl: (id: string, variant?: string) =>
        `https://cloud.oxy.so/${id}${variant ? `?variant=${variant}` : ''}`,
    },
  },
}));
jest.mock('@/config', () => ({ CLARITY_API_URL: 'https://api.clarity.surf' }));

import { feedImageSrc, feedLinkCover, postFeedImages, sizedImageUri } from '../feedImages';

/** A Pixel 8a: 411dp wide at 2.625. The body column is 411 - 64 - 12 = 335dp. */
beforeEach(() => {
  jest
    .spyOn(Dimensions, 'get')
    .mockReturnValue({ width: 411, height: 914, scale: 2.625, fontScale: 1 });
  jest.spyOn(PixelRatio, 'get').mockReturnValue(2.625);
});

describe('sizedImageUri', () => {
  it('asks Oxy Cloud for the rung that covers the drawn width on this screen', () => {
    expect(sizedImageUri('https://cloud.oxy.so/abc?variant=w320', 335)).toBe(
      'https://cloud.oxy.so/abc?variant=w1280',
    );
    expect(sizedImageUri('https://cloud.oxy.so/abc?variant=w320', 200)).toBe(
      'https://cloud.oxy.so/abc?variant=w640',
    );
  });

  it('caps a Clarity cover at the largest rendition Clarity keeps', () => {
    expect(sizedImageUri('https://api.clarity.surf/images/documents/d/v', 1000)).toBe(
      'https://api.clarity.surf/images/documents/d/v?variant=w1280',
    );
  });

  it('leaves what it cannot resize as the server sent it', () => {
    const proxied = 'https://api.mention.earth/media/proxy?url=x&variant=w320';
    expect(sizedImageUri(proxied, 335)).toBe(proxied);
    expect(sizedImageUri('https://cloud.oxy.so/a?variant=w96', 335)).toBe(
      'https://cloud.oxy.so/a?variant=w96',
    );
    expect(sizedImageUri('https://cloud.oxy.so/gif', 335)).toBe('https://cloud.oxy.so/gif');
  });
});

describe('feed image sizes', () => {
  it('sizes an image for its widest form, alone in the row and capped in height', () => {
    // Landscape: the column's width. A tall portrait: 420dp high at its ratio.
    expect(
      feedImageSrc({
        id: 'l',
        type: 'image',
        thumbUrl: 'https://cloud.oxy.so/l?variant=w320',
        aspectRatio: 16 / 9,
      }),
    ).toBe('https://cloud.oxy.so/l?variant=w1280');
    expect(
      feedImageSrc({
        id: 't',
        type: 'image',
        thumbUrl: 'https://cloud.oxy.so/t?variant=w320',
        aspectRatio: 9 / 16,
      }),
    ).toBe('https://cloud.oxy.so/t?variant=w640');
  });

  it('gives a link card one cover URL at the column width on a device', () => {
    expect(feedLinkCover('https://api.clarity.surf/images/documents/d/v')).toBe(
      'https://api.clarity.surf/images/documents/d/v?variant=w1280',
    );
    expect(feedLinkCover(undefined)).toBeUndefined();
  });
});

describe('postFeedImages', () => {
  it('lists what the row draws: the avatar, media, link covers and the quoted post', () => {
    const quoted = {
      id: 'q',
      user: { id: 'u2', avatar: 'face2' },
      content: { text: '' },
    } as unknown as HydratedPost;
    const post = {
      id: 'p',
      user: { id: 'u1', avatar: 'https://cloud.oxy.so/face1?variant=w96' },
      content: { text: 'see https://example.com/a' },
      attachments: {
        media: [
          {
            id: 'i',
            type: 'image',
            thumbUrl: 'https://cloud.oxy.so/i?variant=w320',
            aspectRatio: 1,
          },
          {
            id: 'v',
            type: 'video',
            posterUrl: 'https://cloud.oxy.so/v?variant=w320',
            aspectRatio: 16 / 9,
          },
          { id: 'g', type: 'gif', url: 'https://cloud.oxy.so/g' },
        ],
      },
      documents: [
        {
          canonicalUrl: 'https://example.com/a',
          imageUrl: 'https://api.clarity.surf/images/documents/a/v',
        },
      ],
      quotedPost: quoted,
    } as unknown as HydratedPost;
    expect(postFeedImages(post)).toEqual([
      'https://cloud.oxy.so/face1?variant=w96',
      'https://cloud.oxy.so/i?variant=w1280',
      'https://cloud.oxy.so/v?variant=w1280',
      'https://api.clarity.surf/images/documents/a/v?variant=w1280',
      'https://cloud.oxy.so/face2?variant=w96',
    ]);
  });
});
