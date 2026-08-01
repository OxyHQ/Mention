import { describe, it, expect } from 'vitest';
import { MtnConfig } from '@mention/shared-types';
import { extractTrendTerms, TREND_TERM_STOPWORDS } from '../services/trending/termExtraction';

// Trend-term extraction — the Stage-A step that decides what vocabulary a post
// contributes to trending.
//
// The behaviours asserted here are the ones the whole feature rests on: a
// hashtag and the bare word must collapse to ONE term (otherwise trending is a
// hashtag ranking again), and a phrase must never be glued across a word the
// writer actually used (otherwise the term space fills with pairs nobody said).

describe('extractTrendTerms — hashtag and word collapse', () => {
  it('reduces a hashtag to the bare word, whatever its case', () => {
    expect(extractTrendTerms({ text: '#FIFA is a mess' })).toContain('fifa');
    expect(extractTrendTerms({ text: '#fifa is a mess' })).toContain('fifa');
    expect(extractTrendTerms({ text: 'FIFA is a mess' })).toContain('fifa');
  });

  it('emits the term ONCE when a post uses both spellings', () => {
    const terms = extractTrendTerms({ text: 'FIFA again #FIFA' });
    expect(terms.filter((term) => term === 'fifa')).toHaveLength(1);
  });

  it('includes a caller-supplied hashtag that never appears in the text', () => {
    const terms = extractTrendTerms({ text: 'no tags in this body', hashtags: ['frightclub'] });
    expect(terms).toContain('frightclub');
  });
});

describe('extractTrendTerms — phrases', () => {
  it('emits an adjacent-word phrase alongside its words', () => {
    const terms = extractTrendTerms({ text: 'Todd Blanche testified' });
    expect(terms).toContain('todd blanche');
    expect(terms).toContain('todd');
    expect(terms).toContain('blanche');
  });

  it('never glues a phrase across a stop word', () => {
    // "Kremer and Orioles" — the pair `kremer orioles` was never written.
    const terms = extractTrendTerms({ text: 'Kremer and Orioles' });
    expect(terms).toContain('kremer');
    expect(terms).toContain('orioles');
    expect(terms).not.toContain('kremer orioles');
  });

  it('never glues a phrase across punctuation', () => {
    const terms = extractTrendTerms({ text: 'Kremer, Orioles' });
    expect(terms).not.toContain('kremer orioles');
  });

  it('never glues a phrase across a line break', () => {
    const terms = extractTrendTerms({ text: 'Kremer\nOrioles' });
    expect(terms).not.toContain('kremer orioles');
  });

  it('emits no phrase longer than the configured maximum', () => {
    const terms = extractTrendTerms({ text: 'Dean Kremer Trade Rumours' });
    const longest = Math.max(...terms.map((term) => term.split(' ').length));
    expect(longest).toBe(MtnConfig.trending.terms.maxPhraseTokens);
  });
});

describe('extractTrendTerms — federated mentions never become topics', () => {
  /*
   * A federated reply is stored as `[Display Name](handle@instance.tld)`. Both
   * halves are somebody's identity, and neither is a topic. Every string below
   * is a real post that reached the live trending list through this hole.
   */
  it('drops the recipient handle', () => {
    const terms = extractTrendTerms({ text: '[@Zaph y](weedbunt@posting.onl) i doooo #gangsta' });
    expect(terms).not.toContain('weedbunt');
    expect(terms).not.toContain('posting');
    expect(terms).not.toContain('onl');
    // …while the author's own words survive.
    expect(terms).toContain('gangsta');
  });

  it('drops the recipient display name', () => {
    const terms = extractTrendTerms({
      text: '[@Its Not EZ Growing Colder](tergiversatrix@darkprism.christmas) me',
    });
    expect(terms).toEqual([]);
  });

  it("drops this instance's OWN domain, which is how `mention` came to trend", () => {
    const terms = extractTrendTerms({ text: '[@nate](nate@mention.earth) thanks for the reply' });
    expect(terms).not.toContain('mention');
    expect(terms).not.toContain('earth');
    expect(terms).not.toContain('nate');
    expect(terms).toEqual(['thanks', 'reply']);
  });

  it('drops a bare handle written in prose, leaving no orphaned local part', () => {
    // The `@mention` rule alone would eat `@example.com` and leave `someone`.
    expect(extractTrendTerms({ text: 'contact me at someone@example.com about FIFA' }))
      .toEqual(['contact', 'fifa']);
  });

  it('keeps the LABEL of an ordinary markdown link but not its target', () => {
    const terms = extractTrendTerms({
      text: 'read [this great piece](https://example.com/a/b) about FIFA corruption',
    });
    expect(terms).toContain('great piece');
    expect(terms).toContain('fifa corruption');
    expect(terms).not.toContain('example');
  });
});

describe('extractTrendTerms — what is dropped', () => {
  it('drops URLs entirely', () => {
    const terms = extractTrendTerms({ text: 'read https://example.com/article-about-fifa now' });
    expect(terms).not.toContain('example');
    expect(terms).not.toContain('article');
  });

  it('drops @mentions, including federated ones', () => {
    const terms = extractTrendTerms({ text: 'thanks @nate and @user@mastodon.social' });
    expect(terms).not.toContain('nate');
    expect(terms).not.toContain('mastodon');
  });

  it('drops purely numeric tokens', () => {
    expect(extractTrendTerms({ text: 'final score 2026' })).not.toContain('2026');
  });

  it('drops stop words in every language it knows', () => {
    const terms = extractTrendTerms({ text: 'the que der les nao che' });
    expect(terms).toHaveLength(0);
  });

  it('drops a token longer than the maximum', () => {
    const long = 'a'.repeat(MtnConfig.trending.terms.maxTokenLength + 1);
    expect(extractTrendTerms({ text: `about ${long} here` })).not.toContain(long);
  });
});

describe('extractTrendTerms — acronyms', () => {
  it('keeps a short ALL-CAPS acronym despite the length floor', () => {
    expect(extractTrendTerms({ text: 'EU regulators asked' })).toContain('eu');
  });

  it('drops the same short token when it is not all-caps', () => {
    expect(extractTrendTerms({ text: 'eu regulators asked' })).not.toContain('eu');
  });

  it('drops a single-character token even in caps', () => {
    expect(extractTrendTerms({ text: 'A regulators asked' })).not.toContain('a');
  });
});

describe('extractTrendTerms — bounds', () => {
  it('caps the number of terms per post', () => {
    const text = Array.from({ length: 60 }, (_, index) => `word${index}`).join(' ');
    expect(extractTrendTerms({ text }).length).toBe(MtnConfig.trending.terms.maxTermsPerPost);
  });

  it('keeps the OPENING of the post when it truncates', () => {
    const text = Array.from({ length: 60 }, (_, index) => `word${index}`).join(' ');
    expect(extractTrendTerms({ text })[0]).toBe('word0');
  });

  it('returns nothing for empty or absent text', () => {
    expect(extractTrendTerms({})).toEqual([]);
    expect(extractTrendTerms({ text: '' })).toEqual([]);
    expect(extractTrendTerms({ text: '   ' })).toEqual([]);
  });

  it('returns nothing for emoji-only text', () => {
    expect(extractTrendTerms({ text: '🔥🔥🔥' })).toEqual([]);
  });
});

// VACUITY FLOOR. Every "drops X" assertion above passes trivially if the stop
// word set is empty or the extractor returns nothing at all, so pin the two
// things that would make this file stop testing anything.
describe('extractTrendTerms — the tests above are not vacuous', () => {
  it('has a stop word set with real coverage', () => {
    expect(TREND_TERM_STOPWORDS.size).toBeGreaterThan(100);
  });

  it('extracts something from ordinary prose', () => {
    expect(extractTrendTerms({ text: 'Orioles trading Dean Kremer to Minnesota Twins' }).length)
      .toBeGreaterThan(3);
  });
});
