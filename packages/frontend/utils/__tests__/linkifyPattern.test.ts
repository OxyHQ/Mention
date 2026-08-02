import { LINKIFY_PATTERN } from '../linkifyPattern';

/**
 * The pattern `LinkifiedText` renders with, exercised directly.
 *
 * Rendering the component would need the expo-router/Bloom provider tree; the
 * bug is entirely in which characters the pattern accepts, so this drives the
 * pattern itself — the same object the component imports, not a copy of it.
 */
const entitiesIn = (text: string): string[] => {
  LINKIFY_PATTERN.lastIndex = 0;
  const found: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = LINKIFY_PATTERN.exec(text)) !== null) {
    // Group 6 is the hashtag/cashtag alternative (5 is the preceding boundary).
    if (match[6]) found.push(match[6]);
  }
  return found;
};

describe('LINKIFY_PATTERN — hashtags', () => {
  it('links #BundesländerTurnier WHOLE, not just #Bundesl', () => {
    // The reported bug, on https://mention.earth/p/6a6faff7a2a3bead331e02b5:
    // `#[A-Za-z][A-Za-z0-9_]*` ended the match at the `ä`.
    expect(entitiesIn('Das #BundesländerTurnier war toll')).toEqual([
      '#BundesländerTurnier',
    ]);
  });

  it.each([
    ['accented Latin', '#Café'],
    ['Cyrillic', '#Привет'],
    ['Japanese', '#東京'],
    ['Arabic', '#مرحبا'],
    ['Devanagari with combining marks', '#हिन्दी'],
    ['decomposed Vietnamese', '#Tiếng'],
    ['digits after a letter', '#Top10'],
  ])('links a %s tag whole', (_label, value) => {
    expect(entitiesIn(`before ${value} after`)).toEqual([value]);
  });

  it('leaves a digit-leading tag as plain text, so #2026 does not link', () => {
    expect(entitiesIn('see you in #2026')).toEqual([]);
    expect(entitiesIn('#1 and #_x')).toEqual([]);
  });

  it('stops at an emoji instead of swallowing it', () => {
    expect(entitiesIn('#save🌍earth')).toEqual(['#save']);
  });

  it('treats a non-ASCII letter as inside a word, like an ASCII one', () => {
    // With the old ASCII-only boundary these two disagreed: `é` is not in
    // [A-Za-z0-9_], so `#Bar` opened a tag after `#Café` but not after `#Cafe`.
    expect(entitiesIn('#Cafe#Bar')).toEqual(['#Cafe']);
    expect(entitiesIn('#Café#Bar')).toEqual(['#Café']);
  });

  it('still links a tag after real punctuation or whitespace', () => {
    expect(entitiesIn('(#tag) and #two')).toEqual(['#tag', '#two']);
  });

  it('still matches mentions, URLs and cashtags', () => {
    LINKIFY_PATTERN.lastIndex = 0;
    const text = 'hi [@Dev](dev) see https://mention.earth and $AAPL plus #Café';
    const all = text.match(LINKIFY_PATTERN) ?? [];
    expect(all).toHaveLength(4);
    expect(entitiesIn(text)).toEqual(['$AAPL', '#Café']);
  });
});

describe('LINKIFY_PATTERN — Hermes safety', () => {
  // This regex is built at MODULE LOAD. React Native's Hermes has Unicode
  // property escapes compiled out and throws `SyntaxError: Invalid RegExp:
  // Invalid property name` on every one of them at runtime, so a property escape
  // reaching this pattern crashes the app at boot — on a device only. `hermesc`
  // accepts them, V8 (web, and this test runner) executes them fine, and the
  // Metro bundle builds clean, so nothing else in CI can catch it.
  it('compiles to explicit code-point ranges, never a property escape', () => {
    expect(LINKIFY_PATTERN.source).not.toContain('\\p{');
    expect(LINKIFY_PATTERN.source).not.toContain('\\P{');
  });

  it('carries the u flag the shared class bodies require', () => {
    expect(LINKIFY_PATTERN.flags).toContain('u');
  });

  // Vacuity floor: an empty or ASCII-sized source would satisfy the assertions
  // above while matching none of the scripts the tests exercise.
  it('embeds the full unicode ranges', () => {
    expect(LINKIFY_PATTERN.source.length).toBeGreaterThan(10000);
  });
});
