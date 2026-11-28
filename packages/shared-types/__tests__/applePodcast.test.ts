import { describe, expect, it } from 'bun:test';
import { applePodcastCollectionId } from '../src/applePodcast';

describe('applePodcastCollectionId', () => {
  it('reads the show id from an Apple Podcasts show link, in any storefront', () => {
    expect(
      applePodcastCollectionId('https://podcasts.apple.com/us/podcast/some-show/id1234567890'),
    ).toBe('1234567890');
    expect(applePodcastCollectionId('https://podcasts.apple.com/gb/podcast/id42')).toBe('42');
  });

  it('reads the show of an episode link too', () => {
    expect(
      applePodcastCollectionId('https://podcasts.apple.com/us/podcast/ep/id1234567890?i=1000001'),
    ).toBe('1234567890');
  });

  it('is null for any other link, and for a link that is not https', () => {
    expect(applePodcastCollectionId('https://open.spotify.com/show/abc')).toBeNull();
    expect(applePodcastCollectionId('https://music.youtube.com/podcast/x')).toBeNull();
    expect(applePodcastCollectionId('https://podcasts.apple.com/us/podcast/x/id')).toBeNull();
    expect(applePodcastCollectionId('http://podcasts.apple.com/us/podcast/x/id1')).toBeNull();
    expect(applePodcastCollectionId('not a link')).toBeNull();
  });
});
