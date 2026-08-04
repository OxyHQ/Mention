/**
 * The two decisions in `followGraph.ts` that are expensive to get wrong and
 * silent when they are.
 *
 * A target's URI becomes a permanent row in a graph every Oxy application
 * shares, and `ensureFollowTarget` is idempotent on it — so a URI that differs
 * from what another surface would build does not fail, it quietly gives one
 * person two parallel follows of one topic. And the chip's press rule has a
 * middle case whose wrong answer discards a relationship the person still holds
 * in every other application, while looking like an ordinary unfollow.
 */

import type { FollowApplicationMode } from '@oxyhq/contracts';
import { OXY_TOPIC_KIND, resolveTopicChipAction, topicFollowUri } from '../followGraph';

/** The registry accepts a target URI only if it is absolute. */
const ABSOLUTE_URI = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Mirrors the registry's own `KIND_SHAPE`, reproduced rather than imported: it
 * lives in another repository, and the point is that this constant stays a legal
 * kind however that file moves.
 */
const KIND_SHAPE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

describe('OXY_TOPIC_KIND', () => {
  it('names the PLATFORM kind, so Mention registers nothing for topics', () => {
    // Seeded by migration 0016 with a NULL application_id. If this ever read
    // `mention.topic`, Mention would be claiming an Oxy concept inside its own
    // namespace — and the first registration of a URI fixes its kind forever.
    expect(OXY_TOPIC_KIND).toBe('oxy.topic');
    expect(OXY_TOPIC_KIND).toMatch(KIND_SHAPE);
    expect(OXY_TOPIC_KIND.split('.')[0]).toBe('oxy');
  });
});

describe('topicFollowUri', () => {
  it('names the topic in Oxy’s own vocabulary, so every Oxy surface shares the row', () => {
    expect(topicFollowUri('climate')).toBe('https://oxy.so/topics/climate');
  });

  it('normalizes case and surrounding space, so one topic cannot become two rows', () => {
    expect(topicFollowUri('  Climate  ')).toBe(topicFollowUri('climate'));
  });

  it('escapes a slug rather than letting it change the URI’s shape', () => {
    expect(topicFollowUri('a/b')).toBe('https://oxy.so/topics/a%2Fb');
  });

  it('is absolute, which the registry requires', () => {
    expect(topicFollowUri('climate')).toMatch(ABSOLUTE_URI);
  });
});

describe('resolveTopicChipAction', () => {
  /**
   * Every combination, because the interesting one is a state no fixture
   * produces by accident: followed globally AND switched off in this
   * application. `effectiveState` reports `not_following` for it — correctly,
   * since the question it answers is "does this act here" — so a rule derived
   * from that field alone lands on `follow`, while a rule that only asks
   * "following?" lands on `unfollow`. Both are wrong, and differently.
   */
  const cases: Array<{
    isFollowing: boolean;
    applicationMode: FollowApplicationMode;
    expected: 'follow' | 'unfollow' | 'enable-here';
  }> = [
    { isFollowing: false, applicationMode: 'inherit', expected: 'follow' },
    { isFollowing: false, applicationMode: 'enabled', expected: 'follow' },
    // Not following, and explicitly off here — still nothing to re-enable.
    { isFollowing: false, applicationMode: 'disabled', expected: 'follow' },
    { isFollowing: true, applicationMode: 'inherit', expected: 'unfollow' },
    { isFollowing: true, applicationMode: 'enabled', expected: 'unfollow' },
    { isFollowing: true, applicationMode: 'disabled', expected: 'enable-here' },
  ];

  it.each(cases)(
    'isFollowing=$isFollowing applicationMode=$applicationMode -> $expected',
    ({ isFollowing, applicationMode, expected }) => {
      expect(resolveTopicChipAction({ isFollowing, applicationMode })).toBe(expected);
    },
  );

  it('never unfollows everywhere a relationship that is merely off here', () => {
    // Stated separately from the table because it is the damage, not the
    // mapping: this press must not be able to reach `unfollow`, whatever the
    // rule is later refactored into.
    expect(resolveTopicChipAction({ isFollowing: true, applicationMode: 'disabled' })).not.toBe(
      'unfollow',
    );
  });
});
