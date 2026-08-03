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

/**
 * A profile link on THIS instance reads as a mention.
 *
 * These drive the scan, not the component, for the reason at the top of this
 * file — but the assertions are deliberately about what a reader ends up seeing
 * (`kind`, `label`, and the span the mention covers), because those are the three
 * things `LinkifiedText` renders off.
 */
const scanOne = (text: string) => {
  const entities = scanLinkifyEntities(text);
  expect(entities).toHaveLength(1);
  return entities[0];
};

describe('LinkifiedText scan — a profile link on our own instance', () => {
  it('reads a pasted profile URL as a mention of that user', () => {
    const entity = scanOne('hola https://mention.earth/@alice que tal');
    expect(entity.kind).toBe('mentionDisplay');
    // `value` is what the profile route is built from; `label` is what is shown.
    expect(entity.value).toBe('alice');
    expect(entity.label).toBe('@alice');
  });

  it('covers exactly the URL, so the prose either side is untouched', () => {
    const text = 'hola https://mention.earth/@alice que tal';
    const entity = scanOne(text);
    expect(text.slice(entity.start, entity.end)).toBe('https://mention.earth/@alice');
  });

  it('leaves trailing sentence punctuation outside the mention', () => {
    const text = 'mira https://mention.earth/@alice.';
    const entity = scanOne(text);
    expect(text.slice(entity.start, entity.end)).toBe('https://mention.earth/@alice');
    expect(text.slice(entity.end)).toBe('.');
  });

  it('reads our own actor URI too', () => {
    expect(scanOne('https://mention.earth/ap/users/alice').value).toBe('alice');
  });

  it('reads our own federated profile URL as the federated handle', () => {
    const entity = scanOne('https://mention.earth/@bob@mastodon.social');
    expect(entity.value).toBe('bob@mastodon.social');
    expect(entity.label).toBe('@bob@mastodon.social');
  });

  it('reads the scheme-less www form the scanner also accepts as a link', () => {
    expect(scanOne('www.mention.earth/@alice').value).toBe('alice');
  });
});

describe('LinkifiedText scan — a link that is NOT resolvable stays a link', () => {
  // The whole point of the host gate. A fediverse or upstream profile URL names
  // an account we may not hold, and a mention that resolves to nobody is worse
  // than the URL it replaced — so these must come back as `url`.
  it.each([
    ['another fediverse instance', 'https://mastodon.social/@bob'],
    ['an upstream network', 'https://x.com/elonmusk'],
    ['a bridged network', 'https://bsky.app/profile/alice.bsky.social'],
    ['a host that merely ends with ours', 'https://notmention.earth/@alice'],
    ['a sub-page of one of our profiles', 'https://mention.earth/@alice/followers'],
    ['one of our non-profile pages', 'https://mention.earth/p/abc123'],
    ['an ordinary link', 'https://example.com/some/article'],
  ])('leaves %s as a url', (_label, url) => {
    const entity = scanOne(`mira ${url} vale`);
    expect(entity.kind).toBe('url');
    expect(entity.value).toBe(url);
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
