import { describe, it, expect } from 'vitest';
import { compileMuteWords, isMutedSubject } from '../../services/safety/muteWordMatcher';

/**
 * Muting across writing systems, pinned against the REAL matcher.
 *
 * The word-boundary anchoring is deliberately ASCII (`\w`), which reads like it
 * would make muting inert for scripts that have no ASCII word characters — CJK,
 * Hangul, Cyrillic. It does NOT: because `\w` never matches those characters, no
 * `\b` is added on either side and the pattern degrades to a plain substring,
 * which is exactly the behaviour those scripts need (they are written without
 * spaces, so a boundary-anchored rule would be useless).
 *
 * That is the same rule that keeps a punctuation-only rule like `c++` alive, so
 * these cases are pinned together: a future "fix" that anchors unconditionally
 * would silently kill muting for every one of them at once.
 */

function muted(rule: string, text: string): boolean {
  const compiled = compileMuteWords([{ value: rule, targets: ['content'], actorTarget: 'all' }]);
  return isMutedSubject(compiled, { text }, { isFollowing: false });
}

describe('muted words across writing systems', () => {
  it.each([
    ['政治', 'これは政治の話です', 'Japanese, no spaces'],
    ['선거', '오늘 선거 결과', 'Hangul'],
    ['политика', 'это политика сегодня', 'Cyrillic'],
    ['选举', '关于选举的讨论', 'Simplified Chinese'],
    ['c++', 'writing c++ code today', 'punctuation-only'],
    ['$$$', 'get $$$ fast', 'symbols only'],
  ])('mutes %s (%s)', (rule, text) => {
    expect(muted(rule, text)).toBe(true);
  });

  it('still refuses to mute an ASCII rule that is only a substring', () => {
    expect(muted('art', 'I have a heart')).toBe(false);
    expect(muted('art', 'I love art')).toBe(true);
  });

  it('mutes a rule that mixes ASCII with a script that has no word characters', () => {
    expect(muted('AI政治', 'これはAI政治の話')).toBe(true);
  });
});
