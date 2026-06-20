import { describe, it, expect } from 'vitest';
import {
  mergeHashtags,
  extractHashtags,
  normalizeHashtag,
  normalizePostHashtags,
  SPAM_HASHTAG_BLOCK_THRESHOLD,
} from '../../utils/textProcessing';

// --- normalizeHashtag --------------------------------------------------------
//
// Single canonical recipe shared by the native (mergeHashtags) and federated
// (FederationService.extractApHashtags) write paths: strip a leading #, trim,
// lowercase, then strip every char that is not a unicode letter/number/_.
// Empty/whitespace-only/all-invalid input normalizes to '' so callers can drop
// it. International unicode tags are PRESERVED (not forced to ASCII).

describe('normalizeHashtag', () => {
  it('strips a leading #', () => {
    expect(normalizeHashtag('#Art')).toBe('art');
  });

  it('strips the leading # before trimming, then lowercases', () => {
    expect(normalizeHashtag('#Cartoon  ')).toBe('cartoon');
  });

  it('trims surrounding whitespace and lowercases a bare tag', () => {
    expect(normalizeHashtag('  Painting  ')).toBe('painting');
  });

  it('strips a # anywhere once disallowed chars are removed', () => {
    // The recipe is strip-leading-# → trim → lowercase → remove disallowed
    // chars. Leading whitespace shields the literal `#` from the leading-#
    // strip, but the final disallowed-char pass removes it anyway, so a stray
    // `#` never survives into stored data.
    expect(normalizeHashtag('  #Cartoon  ')).toBe('cartoon');
  });

  it('collapses internal spaces into a single token (the bug)', () => {
    expect(normalizeHashtag('the village and the hills')).toBe('thevillageandthehills');
    expect(normalizeHashtag('#the village and the hills')).toBe('thevillageandthehills');
  });

  it('removes tabs and newlines', () => {
    expect(normalizeHashtag('foo\tbar\nbaz')).toBe('foobarbaz');
  });

  it('removes punctuation', () => {
    expect(normalizeHashtag('hello, world! (yes)')).toBe('helloworldyes');
  });

  it('removes an emoji used as a separator', () => {
    expect(normalizeHashtag('save🌍earth')).toBe('saveearth');
  });

  it('keeps underscores and alphanumerics', () => {
    expect(normalizeHashtag('#my_tag_2')).toBe('my_tag_2');
  });

  it('preserves a legitimate Japanese unicode hashtag', () => {
    expect(normalizeHashtag('#東京')).toBe('東京');
  });

  it('preserves accented / non-ASCII Latin characters', () => {
    expect(normalizeHashtag('#Café')).toBe('café');
    expect(normalizeHashtag('niño')).toBe('niño');
  });

  it('preserves Cyrillic characters', () => {
    expect(normalizeHashtag('#Привет')).toBe('привет');
  });

  it('returns an empty string for empty/whitespace-only input', () => {
    expect(normalizeHashtag('')).toBe('');
    expect(normalizeHashtag('   ')).toBe('');
    expect(normalizeHashtag('#')).toBe('');
  });

  it('returns an empty string for all-invalid input (dropped by callers)', () => {
    expect(normalizeHashtag('!!!')).toBe('');
    expect(normalizeHashtag('   ---   ')).toBe('');
    expect(normalizeHashtag('🚀🚀')).toBe('');
  });

  it('is idempotent over already-normalized input', () => {
    expect(normalizeHashtag('humor')).toBe('humor');
    expect(normalizeHashtag('東京')).toBe('東京');
  });
});

// --- mergeHashtags -----------------------------------------------------------
//
// Hashtags are stored canonical lowercase so they match the case-insensitive
// read paths (getPostsByHashtag, MTN HashtagFeed, the $toLower trending
// aggregations). Both the text-extracted tags and the user-provided tags must
// be lowercased before dedup.

describe('mergeHashtags', () => {
  it('lowercases user-provided hashtags', () => {
    expect(mergeHashtags('', ['Cat', 'Art', 'Cartoon'])).toEqual(['cat', 'art', 'cartoon']);
  });

  it('lowercases hashtags extracted from text', () => {
    expect(mergeHashtags('hello #World')).toEqual(['world']);
  });

  it('deduplicates across user-provided and extracted tags regardless of case', () => {
    expect(mergeHashtags('a #Cat post', ['cat', 'CAT'])).toEqual(['cat']);
  });

  it('trims whitespace from user-provided tags', () => {
    expect(mergeHashtags('', ['  Painting  '])).toEqual(['painting']);
  });

  it('drops empty user-provided tags', () => {
    expect(mergeHashtags('', ['', '   ', 'Funny'])).toEqual(['funny']);
  });

  it('collapses spaces in user-provided tags into a single token', () => {
    expect(mergeHashtags('', ['the village and the hills'])).toEqual(['thevillageandthehills']);
  });

  it('drops user-provided tags that normalize to empty', () => {
    expect(mergeHashtags('', ['!!!', '🚀', 'Real'])).toEqual(['real']);
  });

  it('preserves unicode user-provided tags', () => {
    expect(mergeHashtags('', ['東京', 'Café'])).toEqual(['東京', 'café']);
  });

  it('returns an empty array when there is nothing to merge', () => {
    expect(mergeHashtags('', [])).toEqual([]);
    expect(mergeHashtags('')).toEqual([]);
  });

  it('is idempotent over already-lowercased input', () => {
    expect(mergeHashtags('', ['humor', 'drawing'])).toEqual(['humor', 'drawing']);
  });
});

// --- extractHashtags ---------------------------------------------------------

describe('extractHashtags', () => {
  it('extracts and lowercases tags from text', () => {
    expect(extractHashtags('I love #Art and #ART')).toEqual(['art']);
  });

  it('returns an empty array for empty text', () => {
    expect(extractHashtags('')).toEqual([]);
  });
});

// --- normalizePostHashtags ---------------------------------------------------
//
// The centralized post-hashtag normalizer (issues #166 + #146). Single source of
// truth for: (a) the stored `hashtags` field (lowercase, no #, deduped, order
// preserved) and (b) cleaning spammy 4+ consecutive hashtag blocks from the
// visible `content` text. Threshold lives in SPAM_HASHTAG_BLOCK_THRESHOLD.

describe('normalizePostHashtags', () => {
  it('exposes a threshold of 4', () => {
    expect(SPAM_HASHTAG_BLOCK_THRESHOLD).toBe(4);
  });

  // --- exact expected behavior from the issue --------------------------------

  it('leaves a single natural hashtag in content', () => {
    const r = normalizePostHashtags('Today we improved #Mention and the feed feels much better.');
    expect(r.content).toBe('Today we improved #Mention and the feed feels much better.');
    expect(r.hashtags).toEqual(['mention']);
  });

  it('leaves multiple contextual hashtags used in sentences in content', () => {
    const r = normalizePostHashtags('Testing #Mention today. I think #social products need better discovery.');
    expect(r.content).toBe('Testing #Mention today. I think #social products need better discovery.');
    expect(r.hashtags).toEqual(['mention', 'social']);
  });

  it('cleans a trailing 6-tag block, keeping the first after preceding text', () => {
    const r = normalizePostHashtags('New post about digital communities #startup #social #tech #ai #growth #builders');
    expect(r.content).toBe('New post about digital communities #startup');
    expect(r.hashtags).toEqual(['startup', 'social', 'tech', 'ai', 'growth', 'builders']);
  });

  it('keeps an inline natural hashtag AND the first of a trailing block', () => {
    const r = normalizePostHashtags('I like how #Mention is evolving for public conversations. #social #network #startup #tech #ai #growth');
    expect(r.content).toBe('I like how #Mention is evolving for public conversations. #social');
    expect(r.hashtags).toEqual(['mention', 'social', 'network', 'startup', 'tech', 'ai', 'growth']);
  });

  it('leaves exactly 3 consecutive hashtags fully visible', () => {
    const r = normalizePostHashtags('Testing categories #design #product #ux');
    expect(r.content).toBe('Testing categories #design #product #ux');
    expect(r.hashtags).toEqual(['design', 'product', 'ux']);
  });

  it('removes the whole block when there is no preceding text', () => {
    const r = normalizePostHashtags('#startup #social #tech #ai #growth');
    expect(r.content).toBe('');
    expect(r.hashtags).toEqual(['startup', 'social', 'tech', 'ai', 'growth']);
  });

  // --- threshold boundary ----------------------------------------------------

  it('keeps exactly 3 consecutive hashtags with no preceding text', () => {
    const r = normalizePostHashtags('#design #product #ux');
    expect(r.content).toBe('#design #product #ux');
    expect(r.hashtags).toEqual(['design', 'product', 'ux']);
  });

  it('cleans exactly 4 consecutive hashtags (threshold), no preceding text', () => {
    const r = normalizePostHashtags('#design #product #ux #ai');
    expect(r.content).toBe('');
    expect(r.hashtags).toEqual(['design', 'product', 'ux', 'ai']);
  });

  it('cleans exactly 4 consecutive hashtags (threshold), keeps first after text', () => {
    const r = normalizePostHashtags('Categories #design #product #ux #ai');
    expect(r.content).toBe('Categories #design');
    expect(r.hashtags).toEqual(['design', 'product', 'ux', 'ai']);
  });

  // --- mixed / edge cases ----------------------------------------------------

  it('does not touch a natural hashtag followed by more sentence text', () => {
    const r = normalizePostHashtags('Loving #Mention these days, it keeps getting better.');
    expect(r.content).toBe('Loving #Mention these days, it keeps getting better.');
    expect(r.hashtags).toEqual(['mention']);
  });

  it('deduplicates repeated hashtags but preserves first-seen order', () => {
    const r = normalizePostHashtags('#ai is great. More on #AI and #ml and #ai again.');
    expect(r.hashtags).toEqual(['ai', 'ml']);
  });

  it('normalizes casing in the stored hashtags', () => {
    const r = normalizePostHashtags('Big #News about #TECH and #Growth #AI #ML #Data');
    expect(r.hashtags).toEqual(['news', 'tech', 'growth', 'ai', 'ml', 'data']);
    // Trailing 4-block (#Growth #AI #ML #Data) cleaned, first kept after text.
    expect(r.content).toBe('Big #News about #TECH and #Growth');
  });

  it('merges user-provided tags (without # in text) into hashtags', () => {
    const r = normalizePostHashtags('Plain text with no tags', ['Climate', 'climate', 'Policy']);
    expect(r.content).toBe('Plain text with no tags');
    expect(r.hashtags).toEqual(['climate', 'policy']);
  });

  it('orders user-provided tags before text-extracted tags', () => {
    const r = normalizePostHashtags('text with #inline', ['Provided']);
    expect(r.hashtags).toEqual(['provided', 'inline']);
  });

  it('handles empty/nullish input', () => {
    expect(normalizePostHashtags('')).toEqual({ content: '', hashtags: [] });
    expect(normalizePostHashtags(undefined)).toEqual({ content: '', hashtags: [] });
    expect(normalizePostHashtags(null)).toEqual({ content: '', hashtags: [] });
  });

  it('is idempotent — re-normalizing cleaned content is a no-op', () => {
    const once = normalizePostHashtags('New post about digital communities #startup #social #tech #ai #growth #builders');
    const twice = normalizePostHashtags(once.content);
    expect(twice.content).toBe(once.content);
  });

  it('does not strip a block of 4+ hashtags that is interrupted by words', () => {
    // Not consecutive: each tag is separated by a word, so all stay visible.
    const r = normalizePostHashtags('a #one b #two c #three d #four e');
    expect(r.content).toBe('a #one b #two c #three d #four e');
    expect(r.hashtags).toEqual(['one', 'two', 'three', 'four']);
  });

  it('cleans a 4+ block in the middle followed by more text, keeping first', () => {
    const r = normalizePostHashtags('Intro #a #b #c #d and a closing thought');
    expect(r.content).toBe('Intro #a and a closing thought');
    expect(r.hashtags).toEqual(['a', 'b', 'c', 'd']);
  });

  // --- disallowed-char collapse in user-provided tags ------------------------

  it('collapses space-containing user-provided tags into single tokens', () => {
    const r = normalizePostHashtags('Plain text', ['the village and the hills', 'New York City']);
    expect(r.content).toBe('Plain text');
    expect(r.hashtags).toEqual(['thevillageandthehills', 'newyorkcity']);
  });

  it('drops user-provided tags that normalize to empty', () => {
    const r = normalizePostHashtags('Plain text', ['!!!', '   ', '🚀', 'keep']);
    expect(r.content).toBe('Plain text');
    expect(r.hashtags).toEqual(['keep']);
  });

  it('preserves unicode user-provided tags', () => {
    const r = normalizePostHashtags('Plain text', ['東京', 'Café', 'Привет']);
    expect(r.content).toBe('Plain text');
    expect(r.hashtags).toEqual(['東京', 'café', 'привет']);
  });

  it('strips punctuation/emoji from user-provided tags but keeps the rest', () => {
    const r = normalizePostHashtags('Plain text', ['save🌍earth', 'hello,world']);
    expect(r.hashtags).toEqual(['saveearth', 'helloworld']);
  });
});
