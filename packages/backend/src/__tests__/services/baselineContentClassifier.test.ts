import { describe, it, expect } from 'vitest';
import {
  BaselineContentClassifier,
  baselineContentClassifier,
  BASELINE_CLASSIFIER_VERSION,
  type ClassifyInput,
} from '../../services/BaselineContentClassifier';
import {
  RuleBasedTopicClassifier,
  type TopicClassifier,
  type TopicClassifierInput,
} from '../../services/contentClassification/TopicClassifier';
import { deriveRegion } from '../../services/contentClassification/region';

describe('BaselineContentClassifier', () => {
  describe('languages (multi-language — the single canonical language field)', () => {
    it('prefers an explicitly provided language over detection (primary = languages[0])', () => {
      const result = baselineContentClassifier.classify({
        // English text but an explicit Spanish tag — explicit wins.
        text: 'This is clearly an English sentence with enough length to detect.',
        language: 'es',
      });
      expect(result.languages).toEqual(['es']);
    });

    it('normalizes a BCP-47 provided language to its primary subtag', () => {
      const result = baselineContentClassifier.classify({ text: 'irrelevant text here', language: 'pt-BR' });
      expect(result.languages).toEqual(['pt']);
    });

    it('ignores an unusable provided language and falls back to detection', () => {
      const result = baselineContentClassifier.classify({
        text: 'This is a long enough English sentence to be detected reliably.',
        language: 'english', // not a 2-letter subtag
      });
      expect(result.languages).toEqual(['en']);
    });

    it('records a single language for monolingual text (primary first)', () => {
      const en = baselineContentClassifier.classify({
        text: 'I love how much faster the feed feels now, this is genuinely great news for everyone.',
      });
      expect(en.languages).toEqual(['en']);

      const es = baselineContentClassifier.classify({
        text: 'Me encanta lo rápido que va el feed ahora, son muy buenas noticias para toda la comunidad.',
      });
      expect(es.languages).toEqual(['es']);
    });

    it('detects multiple languages in genuinely bilingual text', () => {
      const result = baselineContentClassifier.classify({
        text:
          'Hello everyone welcome to my channel today thanks for watching. ' +
          'Hola a todos bienvenidos a mi canal de hoy muchas gracias por ver',
      });
      // Both languages present (order is by detection confidence).
      expect(result.languages).toContain('en');
      expect(result.languages).toContain('es');
      expect(result.languages.length).toBe(2);
    });

    it('does not let the long noise tail leak extra languages into a monolingual post', () => {
      // tinyld emits many low-score candidates for monolingual Spanish; only the
      // top candidate clears the secondary gates, so exactly one language remains.
      const result = baselineContentClassifier.classify({
        text: 'El zorro marrón rápido salta sobre el perro perezoso cada mañana sin falta alguna.',
      });
      expect(result.languages).toEqual(['es']);
    });

    it('uses an explicitly declared language list verbatim (federated AP is authoritative)', () => {
      const result = baselineContentClassifier.classify({
        // English-looking text, but the federating server declared es + en.
        text: 'This text is in English but the source declared two languages.',
        languages: ['es', 'en'],
      });
      expect(result.languages).toEqual(['es', 'en']);
    });

    it('merges the singular `language` (leading) with the declared `languages` list, deduped + normalized', () => {
      const result = baselineContentClassifier.classify({
        text: 'irrelevant — declared set is authoritative',
        language: 'pt-BR',
        languages: ['pt', 'en-US'],
      });
      // pt-BR (primary) + pt (dup) + en-US → ['pt', 'en'].
      expect(result.languages).toEqual(['pt', 'en']);
    });

    it('caps the recorded languages at the configured maximum', () => {
      const result = baselineContentClassifier.classify({
        text: 'x',
        languages: ['en', 'es', 'fr', 'de', 'it'],
      });
      expect(result.languages.length).toBeLessThanOrEqual(3);
      expect(result.languages).toEqual(['en', 'es', 'fr']);
    });

    it('returns an empty languages array when no language is determinable', () => {
      expect(baselineContentClassifier.classify({ text: 'hi' }).languages).toEqual([]);
      expect(baselineContentClassifier.classify({ text: 'short one' }).languages).toEqual([]);
      expect(baselineContentClassifier.classify({ text: '🔥🔥🔥' }).languages).toEqual([]);
      expect(baselineContentClassifier.classify({ text: '' }).languages).toEqual([]);
      expect(baselineContentClassifier.classify({}).languages).toEqual([]);
    });
  });

  describe('hashtagsNorm', () => {
    it('normalizes inline + provided hashtags (lowercase, no #, deduped)', () => {
      const result = baselineContentClassifier.classify({
        text: 'Loving #Tech and #tech today',
        hashtags: ['#Design'],
      });
      expect(result.hashtagsNorm).toContain('tech');
      expect(result.hashtagsNorm).toContain('design');
      // 'tech' appears twice in text but is deduped.
      expect(result.hashtagsNorm.filter(t => t === 'tech')).toHaveLength(1);
    });

    it('applies the alias map (artificialintelligence/ml/llm -> ai)', () => {
      const result = baselineContentClassifier.classify({
        text: 'big update #ArtificialIntelligence',
        hashtags: ['ml', 'LLM'],
      });
      expect(result.hashtagsNorm).toContain('ai');
      expect(result.hashtagsNorm).not.toContain('artificialintelligence');
      expect(result.hashtagsNorm).not.toContain('ml');
      expect(result.hashtagsNorm).not.toContain('llm');
      // All three aliases collapse to a single 'ai'.
      expect(result.hashtagsNorm.filter(t => t === 'ai')).toHaveLength(1);
    });

    it('returns an empty array when there are no hashtags', () => {
      expect(baselineContentClassifier.classify({ text: 'no tags here' }).hashtagsNorm).toEqual([]);
    });
  });

  describe('topics (rule-based)', () => {
    it('maps canonical hashtags to topic slugs', () => {
      const result = baselineContentClassifier.classify({
        text: 'check this out #photography #music',
      });
      expect(result.topics).toContain('photography');
      expect(result.topics).toContain('music');
    });

    it('maps aliased hashtags to topics (ai)', () => {
      const result = baselineContentClassifier.classify({ text: 'cool #machinelearning demo' });
      expect(result.topics).toContain('ai');
    });

    it('maps keyword/phrase matches in text to topic slugs', () => {
      const result = baselineContentClassifier.classify({
        text: 'We just shipped a new feature using a neural network and a large language model.',
      });
      expect(result.topics).toContain('ai');
    });

    it('uses whole-word matching (no substring false positives)', () => {
      // "start" must NOT trigger the 'art' topic; "scarttle" must not trigger 'art'.
      const result = baselineContentClassifier.classify({ text: 'we will start the scartttle soon' });
      expect(result.topics).not.toContain('art');
    });

    it('returns [] when nothing matches', () => {
      expect(baselineContentClassifier.classify({ text: 'just saying hello to my friends' }).topics).toEqual([]);
    });

    it('dedupes topics from overlapping hashtag + keyword signals', () => {
      const result = baselineContentClassifier.classify({
        text: 'a recipe for the best restaurant cuisine #food',
      });
      expect(result.topics.filter(t => t === 'food')).toHaveLength(1);
    });

    it('maps expanded aliased hashtags to topics (chatgpt → ai, f1 → sports, netflix → entertainment)', () => {
      expect(baselineContentClassifier.classify({ text: 'wow #chatgpt' }).topics).toContain('ai');
      expect(baselineContentClassifier.classify({ text: 'race day #f1' }).topics).toContain('sports');
      expect(baselineContentClassifier.classify({ text: 'binge #netflix' }).topics).toContain('entertainment');
    });

    it('maps expanded keyword phrases to topics (federal reserve → finance, supreme court → politics)', () => {
      expect(
        baselineContentClassifier.classify({ text: 'the federal reserve held interest rate steady today' }).topics,
      ).toContain('finance');
      expect(
        baselineContentClassifier.classify({ text: 'the supreme court issued a major ruling this morning' }).topics,
      ).toContain('politics');
    });
  });

  describe('region (best-effort, nullable)', () => {
    it('derives region from a ccTLD federated instance', () => {
      const result = baselineContentClassifier.classify({
        text: 'hallo welt, das ist ein test',
        isFederated: true,
        instanceDomain: 'social.example.de',
      });
      expect(result.region).toBe('DE');
    });

    it('derives region from a known national instance host', () => {
      const result = baselineContentClassifier.classify({
        text: 'a federated post from japan',
        isFederated: true,
        instanceDomain: 'mstdn.jp',
      });
      expect(result.region).toBe('JP');
    });

    it('returns undefined for a global instance even on a generic TLD', () => {
      const result = baselineContentClassifier.classify({
        text: 'a federated post from the flagship',
        isFederated: true,
        instanceDomain: 'mastodon.social',
      });
      expect(result.region).toBeUndefined();
    });

    it('does not derive region from instance for non-federated posts', () => {
      const result = baselineContentClassifier.classify({
        text: 'a native post',
        isFederated: false,
        instanceDomain: 'social.example.de',
      });
      expect(result.region).toBeUndefined();
    });

    it('falls back to author locale region when no instance signal', () => {
      const result = baselineContentClassifier.classify({
        text: 'a native post with a locale',
        authorLocale: 'es-ES',
      });
      expect(result.region).toBe('ES');
    });

    it('returns undefined when no region signal exists', () => {
      expect(baselineContentClassifier.classify({ text: 'no signals at all' }).region).toBeUndefined();
    });
  });

  describe('sensitive', () => {
    it('passes the provided sensitive flag through when there is no NSFW signal', () => {
      expect(baselineContentClassifier.classify({ text: 'x', sensitive: true }).sensitive).toBe(true);
      expect(baselineContentClassifier.classify({ text: 'x', sensitive: false }).sensitive).toBe(false);
      expect(baselineContentClassifier.classify({ text: 'x' }).sensitive).toBeUndefined();
    });

    it('marks a post sensitive from an NSFW hashtag in the provided array (source NOT flagged)', () => {
      const result = baselineContentClassifier.classify({
        text: 'check out my latest',
        hashtags: ['#NSFW'],
        // sensitive intentionally omitted: the federating source did not flag it.
      });
      expect(result.sensitive).toBe(true);
    });

    it('marks a post sensitive from an NSFW hashtag parsed from the text (source NOT flagged)', () => {
      const result = baselineContentClassifier.classify({
        text: 'come see more #porn here',
      });
      expect(result.sensitive).toBe(true);
    });

    it('matches NSFW hashtags case-insensitively and with a leading #', () => {
      expect(baselineContentClassifier.classify({ text: 'a', hashtags: ['OnlyFans'] }).sensitive).toBe(true);
      expect(baselineContentClassifier.classify({ text: 'hot #XXX content' }).sensitive).toBe(true);
    });

    it('keeps the source sensitive flag even when there are no NSFW hashtags', () => {
      expect(
        baselineContentClassifier.classify({ text: 'ordinary text', sensitive: true, hashtags: ['tech'] }).sensitive,
      ).toBe(true);
    });

    it('does NOT mark a clean post sensitive (non-NSFW hashtags pass through unchanged)', () => {
      expect(baselineContentClassifier.classify({ text: 'a normal post #tech #music' }).sensitive).toBeUndefined();
      expect(
        baselineContentClassifier.classify({ text: 'a normal post', sensitive: false, hashtags: ['art'] }).sensitive,
      ).toBe(false);
    });
  });

  describe('deterministic scores', () => {
    it('includes finite 0..1 spam/quality/toxicity scores in the output', () => {
      const { scores } = baselineContentClassifier.classify({
        text: 'A perfectly ordinary post about my day.',
      });
      for (const value of [scores.spam, scores.quality, scores.toxicity]) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    });

    it('scores a hashtag-dump post as spammy (using the canonical hashtag count)', () => {
      const clean = baselineContentClassifier.classify({
        text: 'just a normal sentence with real words and no spam at all',
      });
      const dump = baselineContentClassifier.classify({
        text: 'check #a #b #c #d #e #f #g #h',
      });
      expect(dump.scores.spam).toBeGreaterThan(clean.scores.spam);
    });

    it('scores substantive prose higher quality than a one-word post', () => {
      const tiny = baselineContentClassifier.classify({ text: 'lol' });
      const substantive = baselineContentClassifier.classify({
        text: 'I spent the afternoon refactoring the feed ranking. It is finally clean. Very happy with the result!',
      });
      expect(substantive.scores.quality).toBeGreaterThan(tiny.scores.quality);
    });
  });

  describe('version + classifiedAt', () => {
    it('stamps the ruleset version', () => {
      expect(baselineContentClassifier.classify({ text: 'x' }).version).toBe(BASELINE_CLASSIFIER_VERSION);
    });

    it('is at v4 (multi-language ruleset) so the backfill re-derives languages across the corpus', () => {
      expect(BASELINE_CLASSIFIER_VERSION).toBe(4);
    });

    it('stamps an ISO classifiedAt timestamp', () => {
      const at = baselineContentClassifier.classify({ text: 'x' }).classifiedAt;
      expect(typeof at).toBe('string');
      expect(Number.isNaN(Date.parse(at))).toBe(false);
    });
  });

  describe('purity', () => {
    it('does not mutate its input', () => {
      const input: ClassifyInput = {
        text: 'a post about #tech and music',
        hashtags: ['#Design'],
        language: 'en',
        sensitive: true,
        isFederated: true,
        instanceDomain: 'example.de',
        authorLocale: 'de-DE',
      };
      const snapshot = JSON.parse(JSON.stringify(input));
      baselineContentClassifier.classify(input);
      expect(input).toEqual(snapshot);
    });

    it('is deterministic for the same input', () => {
      const input: ClassifyInput = { text: 'a recipe for great food #food', isFederated: true, instanceDomain: 'm.fr' };
      const a = baselineContentClassifier.classify(input);
      const b = baselineContentClassifier.classify(input);
      // classifiedAt is a timestamp; compare everything else.
      const { classifiedAt: _a, ...restA } = a;
      const { classifiedAt: _b, ...restB } = b;
      expect(restA).toEqual(restB);
    });
  });

  describe('TopicClassifier is swappable', () => {
    it('uses an injected topic classifier instead of the rule-based default', () => {
      const calls: TopicClassifierInput[] = [];
      const stub: TopicClassifier = {
        classify(input) {
          calls.push(input);
          return ['injected-topic'];
        },
      };
      const classifier = new BaselineContentClassifier(stub);
      const result = classifier.classify({ text: 'this would normally map to #tech', hashtags: ['tech'] });

      expect(result.topics).toEqual(['injected-topic']);
      // The stub received normalized inputs (lowercased text + canonical hashtags).
      expect(calls).toHaveLength(1);
      expect(calls[0].hashtagsNorm).toContain('tech');
      expect(calls[0].text).toBe('this would normally map to #tech'.toLowerCase());
    });
  });
});

describe('RuleBasedTopicClassifier (direct)', () => {
  const classifier = new RuleBasedTopicClassifier();

  it('returns [] for empty input', () => {
    expect(classifier.classify({ text: '', hashtagsNorm: [] })).toEqual([]);
  });

  it('orders hashtag-driven topics before keyword-driven topics', () => {
    const topics = classifier.classify({
      text: 'this is about basketball and the world cup',
      hashtagsNorm: ['music'],
    });
    expect(topics[0]).toBe('music'); // from hashtag, added first
    expect(topics).toContain('sports'); // from keyword
  });
});

describe('deriveRegion (direct)', () => {
  it('prefers federated instance over locale', () => {
    expect(deriveRegion({ isFederated: true, instanceDomain: 'x.fr', authorLocale: 'de-DE' })).toBe('FR');
  });

  it('uses locale when instance yields nothing', () => {
    expect(deriveRegion({ isFederated: true, instanceDomain: 'x.com', authorLocale: 'de-DE' })).toBe('DE');
  });

  it('returns undefined when both are unknown', () => {
    expect(deriveRegion({ isFederated: true, instanceDomain: 'x.com' })).toBeUndefined();
    expect(deriveRegion({})).toBeUndefined();
  });
});
