/**
 * The decision in `followGraph.ts` that is expensive to get wrong and silent
 * when it is.
 *
 * A target's URI becomes a permanent row in a graph every Oxy application
 * shares, and `ensureFollowTarget` is idempotent on it — so a URI that differs
 * from what another surface would build does not fail, it quietly gives one
 * person two parallel follows of one topic.
 *
 * The chip's press rule used to be tested here too. It is now
 * `resolveFollowPrimaryAction` from `@oxyhq/services`, tested where it lives;
 * what remains on this side is routing its answer to a mutation, which the
 * `never` arm at the call site turns into a type error rather than a silent
 * no-op.
 */

import { OXY_TOPIC_KIND, topicFollowUri } from '../followGraph';

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
