import { describe, expect, it } from 'vitest';
import {
  mapGraphMediaToNormalizedPost,
  planInstagramMedia,
} from '../../../connectors/instagram/media.mapper';
import {
  instagramShortcodeFromPermalink,
  instagramSourceKey,
  instagramSourceKeyFromApObjectUri,
  isInstagramSourceActivityId,
  kilogramNoteIdFor,
} from '../../../connectors/shared/instagramSourceKey';
import {
  BIG_IMAGE_CAROUSEL,
  IMAGE,
  MIXED_CAROUSEL,
  REEL_WITH_VIDEO,
  REEL_WITHOUT_VIDEO,
} from './fixtures/graphSnapshot';

/**
 * Graph media → post, against REAL Business Discovery responses (@zuck, @plex).
 * The mapper is pure, so these pin exactly what gets imported for each shape.
 */

const ACTOR = 'https://kilogram.makeup/users/zuck';

describe('the Instagram source key', () => {
  it.each([
    ['https://www.instagram.com/p/DaX_K4yxa65/', 'DaX_K4yxa65'],
    ['https://www.instagram.com/reel/DbMRPUwsBVT/', 'DbMRPUwsBVT'],
    ['https://instagram.com/reels/DbMRPUwsBVT', 'DbMRPUwsBVT'],
    ['https://www.instagram.com/plex/p/DbROAKNDHnZ/?img_index=1', 'DbROAKNDHnZ'],
  ])('reads the shortcode of %s', (permalink, code) => {
    expect(instagramShortcodeFromPermalink(permalink)).toBe(code);
  });

  it.each([
    'https://www.instagram.com/zuck/',
    'https://evil.example/p/DaX_K4yxa65/',
    'https://www.instagram.com/p/bad code/',
    'not a url',
  ])('refuses %s', (permalink) => {
    expect(instagramShortcodeFromPermalink(permalink)).toBeUndefined();
  });

  it('keeps the shortcode case — Instagram codes are case-sensitive', () => {
    expect(instagramSourceKey('DaX_K4yxa65')).toBe('instagram:DaX_K4yxa65');
  });

  it('derives the same key from a kilogram Note id (shape measured live)', () => {
    expect(
      instagramSourceKeyFromApObjectUri(
        'https://kilogram.makeup/users/natgeo/statuses/DLmzYr6tcKJ',
      ),
    ).toBe('instagram:DLmzYr6tcKJ');
  });

  it.each([
    'https://mastodon.social/users/natgeo/statuses/DLmzYr6tcKJ',
    'https://kilogram.makeup/users/natgeo/statuses/DLmzYr6tcKJ/activity',
    'https://kilogram.makeup/users/natgeo/statuses/DLmzYr6tcKJ?x=1',
    'https://kilogram.makeup/users/natgeo',
    'http://kilogram.makeup/users/natgeo/statuses/DLmzYr6tcKJ',
  ])('gives no key to %s', (uri) => {
    expect(instagramSourceKeyFromApObjectUri(uri)).toBeUndefined();
  });

  it('builds the kilogram Note id a pre-migration row carries', () => {
    expect(kilogramNoteIdFor('https://kilogram.makeup/users/zuck', 'DaX_K4yxa65')).toBe(
      'https://kilogram.makeup/users/zuck/statuses/DaX_K4yxa65',
    );
    expect(kilogramNoteIdFor('https://mastodon.social/users/zuck', 'DaX_K4yxa65')).toBeUndefined();
  });

  it('recognises a Graph-imported activity id and nothing else', () => {
    expect(isInstagramSourceActivityId('instagram:DaX_K4yxa65')).toBe(true);
    expect(
      isInstagramSourceActivityId('https://kilogram.makeup/users/zuck/statuses/DaX_K4yxa65'),
    ).toBe(false);
    expect(isInstagramSourceActivityId('instagram:')).toBe(false);
  });
});

describe('mapping real Graph media', () => {
  it('maps an IMAGE to one image, keyed on its shortcode, with the caption and timestamp', () => {
    const mapped = mapGraphMediaToNormalizedPost(IMAGE, ACTOR);
    expect(mapped).not.toBeNull();
    expect(mapped!.post).toMatchObject({
      network: 'instagram-graph',
      activityId: 'instagram:DaX_K4yxa65',
      actorUri: ACTOR,
      url: 'https://www.instagram.com/p/DaX_K4yxa65/',
      createdAt: new Date(IMAGE.timestamp!),
    });
    expect(mapped!.post.media).toEqual([
      { id: IMAGE.media_url, type: 'image', remoteUrl: IMAGE.media_url },
    ]);
    expect(mapped!.post.text).toBe((IMAGE.caption ?? '').trim());
  });

  it('maps a Reel to its MP4, keeping the thumbnail as the poster fallback', () => {
    const plans = planInstagramMedia(REEL_WITH_VIDEO);
    expect(plans).toEqual([
      {
        primary: {
          id: REEL_WITH_VIDEO.media_url,
          type: 'video',
          remoteUrl: REEL_WITH_VIDEO.media_url,
        },
        fallback: {
          id: REEL_WITH_VIDEO.thumbnail_url,
          type: 'image',
          remoteUrl: REEL_WITH_VIDEO.thumbnail_url,
        },
      },
    ]);
    expect(mapGraphMediaToNormalizedPost(REEL_WITH_VIDEO, ACTOR)!.post.activityId).toBe(
      'instagram:DbOuHlpskDi',
    );
  });

  it('imports the thumbnail as an image when a Reel has no playable file (licensed audio)', () => {
    expect(REEL_WITHOUT_VIDEO.media_url).toBeUndefined();
    const mapped = mapGraphMediaToNormalizedPost(REEL_WITHOUT_VIDEO, ACTOR)!;
    expect(mapped.post.media).toEqual([
      {
        id: REEL_WITHOUT_VIDEO.thumbnail_url,
        type: 'image',
        remoteUrl: REEL_WITHOUT_VIDEO.thumbnail_url,
      },
    ]);
    expect(mapped.mediaPlans[0].fallback).toBeUndefined();
  });

  it('keeps every child of a big carousel, in order', () => {
    const children = BIG_IMAGE_CAROUSEL.children!.data!;
    expect(children).toHaveLength(18);
    const mapped = mapGraphMediaToNormalizedPost(BIG_IMAGE_CAROUSEL, ACTOR)!;
    expect(mapped.post.media!.map((media) => media.id)).toEqual(
      children.map((child) => child.media_url),
    );
    expect(mapped.post.media!.every((media) => media.type === 'image')).toBe(true);
  });

  it('keeps a mixed carousel mixed — videos stay videos, with their posters as fallbacks', () => {
    const children = MIXED_CAROUSEL.children!.data!;
    const mapped = mapGraphMediaToNormalizedPost(MIXED_CAROUSEL, ACTOR)!;
    expect(mapped.post.media!.map((media) => media.type)).toEqual(
      children.map((child) => (child.media_type === 'VIDEO' ? 'video' : 'image')),
    );
    mapped.mediaPlans.forEach((plan, index) => {
      if (children[index].media_type === 'VIDEO') {
        expect(plan.fallback).toEqual({
          id: children[index].thumbnail_url,
          type: 'image',
          remoteUrl: children[index].thumbnail_url,
        });
      } else {
        expect(plan.fallback).toBeUndefined();
      }
    });
  });

  it('extracts hashtags and qualifies bare @handles onto instagram.com', () => {
    const mapped = mapGraphMediaToNormalizedPost(
      { ...IMAGE, caption: 'Night shoot with @reuben #Aurora #lasers' },
      ACTOR,
    )!;
    expect(mapped.post.text).toBe('Night shoot with @reuben@instagram.com #Aurora #lasers');
    expect(mapped.post.hashtags).toEqual(['aurora', 'lasers']);
  });

  it('refuses an item with no shortcode — there would be nothing to dedupe on', () => {
    expect(mapGraphMediaToNormalizedPost({ ...IMAGE, permalink: undefined }, ACTOR)).toBeNull();
  });

  it('refuses non-https media URLs', () => {
    expect(planInstagramMedia({ ...IMAGE, media_url: 'http://insecure.example/a.jpg' })).toEqual(
      [],
    );
  });
});
