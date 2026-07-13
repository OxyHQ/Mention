import { describe, it, expect } from 'vitest';
import {
  detectBotShape,
  type BotShapeFeatures,
} from '../../services/contentClassification/botSignals';
import { SPAM_QUALITY_CONFIG } from '../../services/contentClassification/spamQuality';

/**
 * Unit tests for the pure bot-shape detector. `features` mirrors the structural
 * subset the spam scorer already parses; here they are built by hand to isolate
 * each signal.
 */

const CFG = SPAM_QUALITY_CONFIG.bot;

/** Build the minimal feature set from a raw string + hashtag count. */
function featuresFor(rawText: string, hashtagCount = 0): BotShapeFeatures {
  const visible = rawText
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/#[\p{L}\p{N}_]+/gu, ' ')
    .replace(/@[\p{L}\p{N}_.-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const urlCount = (rawText.match(/https?:\/\/\S+/gi) ?? []).length;
  return { rawText, visible, urlCount, hashtagCount };
}

describe('detectBotShape — RSS/bot mirror (actor + host)', () => {
  it('flags a federated Service actor', () => {
    const result = detectBotShape(featuresFor('hello world'), {
      actorType: 'Service',
      isFederated: true,
    }, CFG);
    expect(result.isRssMirror).toBe(true);
  });

  it('flags a federated Application actor', () => {
    const result = detectBotShape(featuresFor('hello world'), {
      actorType: 'Application',
      isFederated: true,
    }, CFG);
    expect(result.isRssMirror).toBe(true);
  });

  it('flags a mirror-shaped instance host by prefix', () => {
    expect(
      detectBotShape(featuresFor('news'), { instanceDomain: 'rss-mstdn.example', isFederated: true }, CFG).isRssMirror,
    ).toBe(true);
    expect(
      detectBotShape(featuresFor('news'), { instanceDomain: 'bot.example.social', isFederated: true }, CFG).isRssMirror,
    ).toBe(true);
  });

  it('flags a bridge instance host by substring', () => {
    expect(
      detectBotShape(featuresFor('news'), { instanceDomain: 'fed.brid.gy-bridge.net', isFederated: true }, CFG)
        .isRssMirror,
    ).toBe(true);
  });

  it('does NOT flag a normal federated Person on a normal instance', () => {
    const result = detectBotShape(featuresFor('a thoughtful post about my day'), {
      actorType: 'Person',
      instanceDomain: 'mastodon.social',
      isFederated: true,
    }, CFG);
    expect(result.isRssMirror).toBe(false);
  });

  it('NEVER flags a native post as a mirror (no federated origin)', () => {
    // Even if some actorType/host leaked in, a non-federated post is not a mirror.
    const result = detectBotShape(featuresFor('news'), {
      actorType: 'Service',
      instanceDomain: 'rss-mstdn.example',
      isFederated: false,
    }, CFG);
    expect(result.isRssMirror).toBe(false);
  });
});

describe('detectBotShape — link-only news bot (text shape)', () => {
  it('flags a leading link + boilerplate hashtag tail with no prose (no actor metadata)', () => {
    const result = detectBotShape(
      featuresFor('https://news.example/article #news #breaking #world #politics', 4),
      {}, // defense-in-depth: works without actor metadata
      CFG,
    );
    expect(result.isLinkOnlyNewsBot).toBe(true);
  });

  it('flags a leading link + short headline + hashtag tail', () => {
    const result = detectBotShape(
      featuresFor('https://news.example/x New patch released #gaming #news #update #patch', 4),
      {},
      CFG,
    );
    expect(result.isLinkOnlyNewsBot).toBe(true);
  });

  it('does NOT flag a post with a link but real writing before it', () => {
    const result = detectBotShape(
      featuresFor(
        'I read this really interesting long-form piece this morning and wanted to share my thoughts: https://blog.example/post #reading',
        1,
      ),
      {},
      CFG,
    );
    expect(result.isLinkOnlyNewsBot).toBe(false);
  });

  it('does NOT flag a leading link when the hashtag tail is below threshold', () => {
    const result = detectBotShape(
      featuresFor('https://news.example/article #news', 1),
      {},
      CFG,
    );
    expect(result.isLinkOnlyNewsBot).toBe(false);
  });

  it('does NOT flag a hashtag-heavy post with no link', () => {
    const result = detectBotShape(
      featuresFor('big day #news #breaking #world #politics', 4),
      {},
      CFG,
    );
    expect(result.isLinkOnlyNewsBot).toBe(false);
  });
});
