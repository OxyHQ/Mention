import { describe, it, expect } from 'vitest';
import { mergeHashtags, extractHashtags } from '../../utils/textProcessing';

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
