import { describe, it, expect } from 'vitest';
import { detectLowEffort } from '../../services/contentClassification/lowEffort';
import { SPAM_QUALITY_CONFIG } from '../../services/contentClassification/spamQuality';

/**
 * Unit tests for the pure low-effort detector. Inputs isolate one shape at a time
 * and assert against the configured threshold, not hardcoded internals.
 */

const CFG = SPAM_QUALITY_CONFIG.lowEffort;

describe('detectLowEffort — shortcode-only', () => {
  it('flags a custom-emoji shortcode-only post', () => {
    const result = detectLowEffort(':oyaki::oyaki::oyaki:', CFG);
    expect(result.realTextLength).toBe(0);
    expect(result.isNoRealText).toBe(true);
    expect(result.shortcodeOnly).toBe(true);
    expect(result.emojiOnly).toBe(false);
  });

  it('flags shortcodes mixed with only emoji/punctuation/space', () => {
    const result = detectLowEffort(':blob_cat: :+1: !!! 🔥', CFG);
    expect(result.shortcodeOnly).toBe(true);
    expect(result.isNoRealText).toBe(true);
  });

  it('does NOT flag shortcodeOnly when real words are present', () => {
    const result = detectLowEffort('great work today :oyaki:', CFG);
    expect(result.shortcodeOnly).toBe(false);
    expect(result.isNoRealText).toBe(false);
    expect(result.realTextLength).toBeGreaterThan(CFG.minRealTextLength);
  });

  it('does NOT flag shortcodeOnly when a URL/mention/hashtag is present', () => {
    expect(detectLowEffort(':oyaki: https://x.example', CFG).shortcodeOnly).toBe(false);
    expect(detectLowEffort(':oyaki: @someone', CFG).shortcodeOnly).toBe(false);
    expect(detectLowEffort(':oyaki: #topic', CFG).shortcodeOnly).toBe(false);
  });
});

describe('detectLowEffort — emoji-only', () => {
  it('flags a Unicode-emoji-only post', () => {
    const result = detectLowEffort('🔥🔥🔥🚀🚀', CFG);
    expect(result.realTextLength).toBe(0);
    expect(result.isNoRealText).toBe(true);
    expect(result.emojiOnly).toBe(true);
    expect(result.shortcodeOnly).toBe(false);
  });

  it('is emoji + punctuation tolerant', () => {
    expect(detectLowEffort('🎉!!! 🥳 ...', CFG).emojiOnly).toBe(true);
  });

  it('is NOT emojiOnly when shortcodes are also present (that is shortcodeOnly)', () => {
    const result = detectLowEffort(':party: 🎉', CFG);
    expect(result.emojiOnly).toBe(false);
    expect(result.shortcodeOnly).toBe(true);
  });
});

describe('detectLowEffort — real text', () => {
  it('counts letters after stripping all scaffolding', () => {
    const result = detectLowEffort(
      'Check https://x.example @friend #news this is a real sentence',
      CFG,
    );
    expect(result.isNoRealText).toBe(false);
    expect(result.shortcodeOnly).toBe(false);
    expect(result.emojiOnly).toBe(false);
    expect(result.realTextLength).toBeGreaterThan(CFG.minRealTextLength);
  });

  it('leaves a short two-letter reply above the no-real-text bar (regression: "OK")', () => {
    // "OK" is 2 letters; minRealTextLength is 2, so 2 < 2 is false → real text.
    expect(detectLowEffort('OK', CFG).isNoRealText).toBe(false);
  });

  it('treats empty / whitespace text as no real text without throwing', () => {
    expect(detectLowEffort('', CFG).isNoRealText).toBe(true);
    expect(detectLowEffort('   ', CFG).realTextLength).toBe(0);
  });
});
