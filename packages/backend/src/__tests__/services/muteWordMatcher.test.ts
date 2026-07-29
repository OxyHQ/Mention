import { describe, expect, it } from 'vitest';
import {
  NO_FOLLOWED_AUTHORS,
  compileMuteWords,
  isMutedSubject,
  type MuteWordRule,
} from '../../services/safety/muteWordMatcher';

function rule(overrides: Partial<MuteWordRule> & Pick<MuteWordRule, 'value'>): MuteWordRule {
  return { targets: ['content', 'tag'], actorTarget: 'all', ...overrides };
}

/** Compile + match in one step, for the cases that do not care about follow state. */
function muted(rules: MuteWordRule[], subject: Parameters<typeof isMutedSubject>[1]): boolean {
  return isMutedSubject(compileMuteWords(rules), subject, NO_FOLLOWED_AUTHORS);
}

describe('compileMuteWords', () => {
  it('returns null when there is nothing to match, so callers can skip filtering', () => {
    expect(compileMuteWords(undefined)).toBeNull();
    expect(compileMuteWords([])).toBeNull();
    expect(compileMuteWords([rule({ value: '   ' })])).toBeNull();
    expect(compileMuteWords([rule({ value: 'spoilers', targets: [] })])).toBeNull();
  });

  it('reports needsFollowState only when an exclude-following rule exists', () => {
    expect(compileMuteWords([rule({ value: 'spoilers' })])?.needsFollowState).toBe(false);
    expect(
      compileMuteWords([rule({ value: 'spoilers', actorTarget: 'exclude-following' })])?.needsFollowState,
    ).toBe(true);
  });
});

describe('isMutedSubject content target', () => {
  it('matches a muted word in the post text', () => {
    expect(muted([rule({ value: 'spoilers' })], { text: 'huge SPOILERS ahead' })).toBe(true);
  });

  it('does not match a muted word embedded inside a longer word', () => {
    expect(muted([rule({ value: 'art' })], { text: 'she has a big heart' })).toBe(false);
  });

  it('treats the muted value as a literal, never as a regex', () => {
    expect(muted([rule({ value: 'a.c' })], { text: 'abc' })).toBe(false);
    expect(muted([rule({ value: 'a.c' })], { text: 'a.c' })).toBe(true);
  });

  it('still matches a value whose edges are not word characters', () => {
    // `\bc\+\+\b` can never match: there is no word boundary after `+`. Anchoring
    // only where the value has a word character keeps the rule alive.
    expect(muted([rule({ value: 'c++' })], { text: 'rewrote it in c++ today' })).toBe(true);
    expect(muted([rule({ value: '$$$' })], { text: 'pay me $$$' })).toBe(true);
  });

  it('ignores the content target when the rule only targets tags', () => {
    expect(muted([rule({ value: 'spoilers', targets: ['tag'] })], { text: 'spoilers ahead' })).toBe(false);
  });
});

describe('isMutedSubject tag target', () => {
  it('matches a muted hashtag regardless of case', () => {
    expect(muted([rule({ value: 'politics', targets: ['tag'] })], { hashtags: ['Politics'] })).toBe(true);
  });

  it('ignores hashtags when the rule only targets content', () => {
    expect(muted([rule({ value: 'politics', targets: ['content'] })], { hashtags: ['politics'] })).toBe(false);
  });

  it('does not match a hashtag as a substring of another tag', () => {
    expect(muted([rule({ value: 'art', targets: ['tag'] })], { hashtags: ['artist'] })).toBe(false);
  });
});

describe('isMutedSubject actorTarget scope', () => {
  const excludeFollowing = [rule({ value: 'spoilers', actorTarget: 'exclude-following' })];

  it('mutes a non-followed author', () => {
    const compiled = compileMuteWords(excludeFollowing);
    expect(isMutedSubject(compiled, { text: 'spoilers!', authorId: 'stranger' }, new Set(['friend']))).toBe(true);
  });

  it('spares an author the viewer follows', () => {
    const compiled = compileMuteWords(excludeFollowing);
    expect(isMutedSubject(compiled, { text: 'spoilers!', authorId: 'friend' }, new Set(['friend']))).toBe(false);
  });

  it('applies an `all` rule even to a followed author', () => {
    const compiled = compileMuteWords([rule({ value: 'spoilers', actorTarget: 'all' })]);
    expect(isMutedSubject(compiled, { text: 'spoilers!', authorId: 'friend' }, new Set(['friend']))).toBe(true);
  });

  it('mutes an author it cannot identify, since it cannot be a follow', () => {
    const compiled = compileMuteWords(excludeFollowing);
    expect(isMutedSubject(compiled, { text: 'spoilers!' }, new Set(['friend']))).toBe(true);
  });
});

describe('isMutedSubject with no rules', () => {
  it('never mutes when the viewer has no muted words', () => {
    expect(isMutedSubject(null, { text: 'anything at all', hashtags: ['nsfw'] }, NO_FOLLOWED_AUTHORS)).toBe(false);
  });
});
