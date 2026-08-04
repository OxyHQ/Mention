import { describe, expect, it } from 'vitest';
import {
  buildFeedDescriptor,
  isValidFeedDescriptor,
  parseFeedDescriptor,
  AUTHOR_FEED_FILTERS,
} from '@mention/shared-types';

/**
 * The `lane|<laneId>` descriptor — ONE parameter, its own source, and NOT an
 * author-feed filter.
 *
 * `isValidFeedDescriptor` is a closed allowlist on the hottest public entry
 * point, so a source that is not in it 400s. The three tests that matter are the
 * arity (an extra param must not be accepted), the resolution (the descriptor
 * must reach `laneDefinition`), and the fact that `AuthorFeedFilter` was left
 * alone — a lane is dynamic, and that union is documented as 1:1 with the static
 * profile tabs.
 */

// `resolveDefinition` reaches presets, which read config. Nothing here opens a
// database: descriptor parsing and definition resolution are pure, and the lane
// SOURCE — the only part that queries — is another suite's subject.
import { resolveDefinition } from '../mtn/feed/definitions/resolveDefinition';
import { laneDefinition } from '../mtn/feed/definitions/presets';

const LANE_ID = '65b0c9178fcdefaf81988ffb';

describe('lane feed descriptor', () => {
  it('accepts exactly one non-empty parameter', () => {
    expect(isValidFeedDescriptor(`lane|${LANE_ID}`)).toBe(true);
    expect(isValidFeedDescriptor('lane')).toBe(false);
    expect(isValidFeedDescriptor('lane|')).toBe(false);
    expect(isValidFeedDescriptor('lane|   ')).toBe(false);
    // A second parameter would be the owner — deliberately NOT in the
    // descriptor, because the lane already knows its own publisher and encoding
    // it would also force encoding the owner's TYPE.
    expect(isValidFeedDescriptor(`lane|${LANE_ID}|user`)).toBe(false);
  });

  it('parses back to the lane source and its id', () => {
    expect(parseFeedDescriptor(`lane|${LANE_ID}`)).toEqual({ source: 'lane', params: [LANE_ID] });
  });

  it('round-trips through buildFeedDescriptor', () => {
    expect(buildFeedDescriptor('lane', LANE_ID)).toBe(`lane|${LANE_ID}`);
  });

  it('leaves AuthorFeedFilter untouched — a lane is not a static profile tab', () => {
    expect([...AUTHOR_FEED_FILTERS]).toEqual([
      'posts',
      'replies',
      'media',
      'videos',
      'likes',
      'boosts',
    ]);
    expect(isValidFeedDescriptor(`author|u1|${LANE_ID}`)).toBe(false);
  });
});

describe('lane definition resolution', () => {
  it('resolves to a chronological single-source lane feed', async () => {
    const definition = await resolveDefinition(`lane|${LANE_ID}`);

    expect(definition).not.toBeNull();
    expect(definition?.id).toBe(`lane|${LANE_ID}`);
    expect(definition?.mode).toBe('chronological');
    expect(definition?.sources).toEqual([
      { module: 'lane', enabled: true, params: { laneId: LANE_ID } },
    ]);
    expect(definition?.filters).toEqual([{ module: 'safety', enabled: true }]);
  });

  it('hydrates at depth 0 — a lane holds original posts, never boosts', () => {
    expect(laneDefinition(LANE_ID).execution?.hydrateMaxDepth).toBe(0);
  });

  it('resolves to null without a lane id', async () => {
    await expect(resolveDefinition('lane|')).resolves.toBeNull();
  });
});
