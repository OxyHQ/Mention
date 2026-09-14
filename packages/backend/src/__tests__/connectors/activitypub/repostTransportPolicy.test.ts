import { describe, expect, it } from 'vitest';
import { dropsFlattenedReposts, REVIEWED_REPOST_TRANSPORT_HOSTS } from '../../../connectors/activitypub/repostTransportPolicy';
describe('reviewed content transports', () => {
  it('preserves the historical RT gate without account or profile derivation', () => {
    for (const host of REVIEWED_REPOST_TRANSPORT_HOSTS) expect(dropsFlattenedReposts(host)).toBe(true);
    expect(dropsFlattenedReposts(' BIRD.MAKEUP ')).toBe(true);
    expect(dropsFlattenedReposts('bird.makeup.evil.example')).toBe(false);
    expect(dropsFlattenedReposts('threads.net')).toBe(false);
    expect(dropsFlattenedReposts('mastodon.social')).toBe(false);
  });
});
