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
// lowercase. Empty/whitespace-only input normalizes to '' so callers can drop it.

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

  it('only strips a leading # (matching the original recipe order)', () => {
    // The recipe is replace(/^#/, '').trim().toLowerCase(): the # is stripped
    // before the trim, so leading whitespace shields the #. This is unchanged
    // from the duplicated inline recipes and is not a real-world AP tag shape.
    expect(normalizeHashtag('  #Cartoon  ')).toBe('#cartoon');
  });

  it('returns an empty string for empty/whitespace-only input', () => {
    expect(normalizeHashtag('')).toBe('');
    expect(normalizeHashtag('   ')).toBe('');
    expect(normalizeHashtag('#')).toBe('');
  });

  it('is idempotent over already-normalized input', () => {
    expect(normalizeHashtag('humor')).toBe('humor');
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
});
