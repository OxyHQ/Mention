import { LINKIFY_PATTERN_SOURCE, scanLinkifyEntities } from '../linkifyPattern';

/**
 * The scan `LinkifiedText` renders with, exercised directly.
 *
 * Rendering the component would need the expo-router/Bloom provider tree; the
 * bug is entirely in which characters the scan accepts, so this drives the scan
 * itself — the same function the component imports, not a copy of it.
 */
const entitiesIn = (text: string): string[] =>
  scanLinkifyEntities(text)
    .filter((entity) => entity.kind === 'hashtag' || entity.kind === 'cashtag')
    .map((entity) => entity.raw);

describe('LinkifiedText scan — hashtags', () => {
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
    const text = 'hi [@Dev](dev) see https://mention.earth and $AAPL plus #Café';
    expect(scanLinkifyEntities(text).map((entity) => entity.kind)).toEqual([
      'mentionDisplay',
      'url',
      'cashtag',
      'hashtag',
    ]);
    expect(entitiesIn(text)).toEqual(['$AAPL', '#Café']);
  });

  it('does not linkify an unresolved [mention:<id>] placeholder', () => {
    // Hydration turns an authorized mention into the `[@Label](handle)` form.
    // A raw placeholder reaching the renderer was never resolved, so linking it
    // would fabricate a profile link out of text somebody typed.
    expect(scanLinkifyEntities('hi [mention:abc123] there')).toEqual([]);
  });
});

describe('LinkifiedText scan — Hermes safety', () => {
  // This regex is built at MODULE LOAD. React Native's Hermes has Unicode
  // property escapes compiled out and throws `SyntaxError: Invalid RegExp:
  // Invalid property name` on every one of them at runtime, so a property escape
  // reaching this pattern crashes the app at boot — on a device only. `hermesc`
  // accepts them, V8 (web, and this test runner) executes them fine, and the
  // Metro bundle builds clean, so nothing else in CI can catch it.
  it('compiles to explicit code-point ranges, never a property escape', () => {
    expect(LINKIFY_PATTERN_SOURCE).not.toContain('\\p{');
    expect(LINKIFY_PATTERN_SOURCE).not.toContain('\\P{');
  });

  // Vacuity floor: an empty or ASCII-sized source would satisfy the assertion
  // above while matching none of the scripts the tests exercise.
  it('embeds the full unicode ranges', () => {
    expect(LINKIFY_PATTERN_SOURCE.length).toBeGreaterThan(10000);
  });
});
