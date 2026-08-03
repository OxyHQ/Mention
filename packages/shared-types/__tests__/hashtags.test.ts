import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  HASHTAG_BODY_SOURCE,
  HASHTAG_BOUNDARY_SOURCE,
  HASHTAG_CONTINUE_CLASS,
  HASHTAG_DISALLOWED_SOURCE,
  HASHTAG_LEADING_MARKS_SOURCE,
  HASHTAG_START_CLASS,
  HASHTAG_TOKEN_SOURCE,
} from '../src/hashtags';

const tag = new RegExp(`^#${HASHTAG_BODY_SOURCE}$`, 'u');
const firstTagIn = (text: string): string | undefined =>
  text.match(new RegExp(HASHTAG_TOKEN_SOURCE, 'u'))?.[0];

// --- the reported bug --------------------------------------------------------

describe('hashtag definition — the reported bug', () => {
  it('matches #BundesländerTurnier WHOLE, not just #Bundesl', () => {
    // https://mention.earth/p/6a6faff7a2a3bead331e02b5 rendered the link as
    // `#Bundesl` because the character class ended at the `ä`.
    expect(firstTagIn('Das #BundesländerTurnier war toll')).toBe('#BundesländerTurnier');
  });
});

// --- which characters are a hashtag ------------------------------------------

describe('hashtag definition — accepted', () => {
  it.each([
    ['accented Latin', '#Café'],
    ['German umlaut mid-word', '#BundesländerTurnier'],
    ['Cyrillic', '#Привет'],
    ['Greek', '#Ελλάδα'],
    ['Japanese', '#東京'],
    ['Korean', '#서울'],
    ['Arabic', '#مرحبا'],
    ['Hebrew', '#שלום'],
    // A written Devanagari letter is not one code point: this contains the
    // combining vowel sign ि (U+093F) and the virama ् (U+094D).
    ['Devanagari with combining marks', '#हिन्दी'],
    ['Thai with vowel signs', '#ไทย'],
    ['decomposed Vietnamese', '#Tiếng'],
    ['digits after a letter', '#Top10'],
    ['underscores', '#my_tag_2'],
    ['astral (Gothic) letters', '#\u{10330}\u{10331}'],
  ])('accepts %s', (_label, value) => {
    expect(tag.test(value)).toBe(true);
  });
});

describe('hashtag definition — rejected', () => {
  it('does not match a digit-leading tag, so #2026 stays plain text', () => {
    expect(tag.test('#2026')).toBe(false);
    expect(firstTagIn('see you in #2026')).toBeUndefined();
  });

  it('does not match #1', () => {
    expect(tag.test('#1')).toBe(false);
  });

  it('does not match an underscore-leading tag', () => {
    expect(tag.test('#_private')).toBe(false);
  });

  it('does not match a bare #', () => {
    expect(tag.test('#')).toBe(false);
  });

  it('excludes emoji — they are symbols, not letters', () => {
    expect(firstTagIn('#save🌍earth')).toBe('#save');
    expect(tag.test('#🌍')).toBe(false);
  });

  it('stops at punctuation and whitespace', () => {
    expect(firstTagIn('#tag, and more')).toBe('#tag');
    expect(firstTagIn('#tag.next')).toBe('#tag');
    expect(firstTagIn('#tag one')).toBe('#tag');
  });

  it('does not let a leading combining mark open a tag', () => {
    expect(tag.test('#́abc')).toBe(false);
  });
});

// --- the word boundary -------------------------------------------------------

describe('HASHTAG_BOUNDARY_SOURCE', () => {
  const boundary = new RegExp(`^${HASHTAG_BOUNDARY_SOURCE}$`, 'u');

  it('treats a non-ASCII letter as inside a word, like an ASCII one', () => {
    // The ASCII-only boundary made `#Café#Bar` and `#Cafe#Bar` behave
    // differently: `é` is not in [A-Za-z0-9_], so the second `#` opened a tag in
    // one and not the other.
    expect(boundary.test('e')).toBe(false);
    expect(boundary.test('é')).toBe(false);
    expect(boundary.test('東')).toBe(false);
    expect(boundary.test('_')).toBe(false);
    expect(boundary.test('7')).toBe(false);
  });

  it('treats separators and punctuation as a boundary', () => {
    expect(boundary.test(' ')).toBe(true);
    expect(boundary.test('.')).toBe(true);
    expect(boundary.test('(')).toBe(true);
  });
});

// --- equivalence with the Unicode property escapes ---------------------------

describe('generated ranges', () => {
  // The classes are built by concatenating three generated range bodies. This
  // sweeps EVERY code point against the property escapes they were transpiled
  // from, so a concatenation that silently formed a wrong range (or a stale
  // regeneration) cannot pass.
  //
  // The reference patterns are built with `new RegExp` from strings so this
  // file's own property escapes are never regex literals — V8 evaluates them,
  // Hermes never sees this file.
  const sweep = (mine: RegExp, reference: RegExp): number => {
    let mismatches = 0;
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogates
      const ch = String.fromCodePoint(cp);
      if (mine.test(ch) !== reference.test(ch)) mismatches++;
    }
    return mismatches;
  };

  it('HASHTAG_START_CLASS matches exactly \\p{L}', () => {
    expect(
      sweep(
        new RegExp(`^[${HASHTAG_START_CLASS}]$`, 'u'),
        new RegExp('^[\\p{L}]$', 'u'),
      ),
    ).toBe(0);
  });

  it('HASHTAG_CONTINUE_CLASS matches exactly \\p{L}\\p{N}\\p{M} and _', () => {
    expect(
      sweep(
        new RegExp(`^[${HASHTAG_CONTINUE_CLASS}]$`, 'u'),
        new RegExp('^[\\p{L}\\p{N}\\p{M}_]$', 'u'),
      ),
    ).toBe(0);
  });
});

// --- Hermes safety (the gate) ------------------------------------------------

describe('Hermes safety', () => {
  // React Native's Hermes has Unicode property escapes compiled OUT: every
  // `\p{…}` atom in a u-flag regex throws `SyntaxError: Invalid RegExp: Invalid
  // property name` at RUNTIME, and one evaluated at module load crashes the app
  // at boot. This package is built with `tsc`, which ships regex sources
  // verbatim into the Metro bundle, and neither `hermesc` nor any web/V8 run
  // reproduces the crash — so this assertion is the only thing between a
  // reintroduced `\p{…}` and a device.
  const SHIPPED_SOURCES = [
    'src/hashtags.ts',
    'src/hashtagRanges.generated.ts',
    'src/textEntities.ts',
  ];

  it.each(SHIPPED_SOURCES)('%s contains no Unicode property escape', (relative) => {
    const contents = readFileSync(join(import.meta.dir, '..', relative), 'utf8');
    const offenders = contents
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /\\[pP]\{/.test(line));
    // Print the whole offending line, never a truncated capture group.
    expect(offenders.map(({ n, line }) => `${relative}:${n}: ${line.trim()}`)).toEqual([]);
  });

  it.each([
    ['HASHTAG_START_CLASS', HASHTAG_START_CLASS],
    ['HASHTAG_CONTINUE_CLASS', HASHTAG_CONTINUE_CLASS],
    ['HASHTAG_BODY_SOURCE', HASHTAG_BODY_SOURCE],
    ['HASHTAG_TOKEN_SOURCE', HASHTAG_TOKEN_SOURCE],
    ['HASHTAG_BOUNDARY_SOURCE', HASHTAG_BOUNDARY_SOURCE],
    ['HASHTAG_DISALLOWED_SOURCE', HASHTAG_DISALLOWED_SOURCE],
    ['HASHTAG_LEADING_MARKS_SOURCE', HASHTAG_LEADING_MARKS_SOURCE],
  ])('%s carries no property escape and compiles in u-mode', (_name, source) => {
    expect(source).not.toContain('\\p{');
    expect(source).not.toContain('\\P{');
    expect(() => new RegExp(source, 'u')).not.toThrow();
  });

  // Vacuity floor: a generator that emitted empty or near-empty bodies would
  // make every assertion above pass while matching nothing. \p{L} alone spans
  // thousands of characters, so these are far below a healthy value and far
  // above a broken one.
  it('the generated ranges are non-trivial', () => {
    expect(HASHTAG_START_CLASS.length).toBeGreaterThan(4000);
    expect(HASHTAG_CONTINUE_CLASS.length).toBeGreaterThan(HASHTAG_START_CLASS.length);
  });
});
