/**
 * Content a paid Boost can never be bought for (docs/boost.md).
 *
 * The owner's rule: posts about politics, gambling and casinos, animal sales, and anything else that
 * goes against Oxy's ethical standards are not eligible. Payment never widens a gate, so this is a
 * refusal, decided here and not by the buyer.
 *
 * It is deliberately CONSERVATIVE: a paid distribution that wrongly refuses costs the buyer a clearer
 * post, one that wrongly accepts costs the product its standards, so every rule below prefers to
 * refuse. Politics comes from the Stage-A classifier's own topic (the taxonomy has `politics`);
 * gambling and animal sales are not topics the classifier emits, so they are matched here on the
 * hashtags and the words of the post, in the languages the app ships in the most. A matcher is a
 * first line, not the last: a post that slips through is still reportable, and a report pauses its
 * promotion.
 *
 * Pure: the caller supplies what it already loaded.
 */

/** The categories a post can be refused for. Stable strings: clients map them to copy. */
export type ExcludedCategory = 'politics' | 'gambling' | 'animal-sales';

/** What the matchers read of a post. */
export interface ExclusionFacts {
  /** The classifier's topic slugs (Stage A + B). */
  topics?: readonly string[] | null;
  /** The post's hashtags, with or without the `#`, any case. */
  hashtags?: readonly string[] | null;
  /** Every language rendition of the body. */
  texts?: readonly string[] | null;
}

/** Gambling and casinos: whole words, so "bingo" matches and "cabingo" does not. */
const GAMBLING =
  /(?<![\p{L}\p{N}])(?:casinos?|gambling|gamble|gambler|betting|sportsbook|bookmaker|bet365|poker|slots?|jackpot|roulette|ruleta|blackjack|bingo|lotter(?:y|ies)|loter[ií]as?|tragaperras|apuestas?|apostar|apostando|casas? de apuestas|paris sportifs|sportwetten|scommesse)(?![\p{L}\p{N}])/iu;

/** Words for the animals people sell, in the languages the app ships in the most. */
const ANIMAL =
  '(?:puppy|puppies|dogs?|kittens?|cats?|horses?|ponies|birds?|parrots?|reptiles?|snakes?|rabbits?|hamsters?|cachorros?|perros?|perritos?|gatos?|gatitos?|caballos?|loros?|pajaros?|p[aá]jaros?|conejos?|chiots?|chiens?|chats?|chatons?|welpen|hunde|katzen|cuccioli|cani|gatti)';
const SALE =
  '(?:for sale|selling|up for adoption for|se vende(?:n)?|en venta|venta de|vendo|vendemos|[àa] vendre|zu verkaufen|in vendita|vendesi)';
const ANIMAL_SALE = new RegExp(
  `(?<![\\p{L}\\p{N}])${SALE}(?![\\p{L}\\p{N}]).{0,60}(?<![\\p{L}\\p{N}])${ANIMAL}(?![\\p{L}\\p{N}])|(?<![\\p{L}\\p{N}])${ANIMAL}(?![\\p{L}\\p{N}]).{0,60}(?<![\\p{L}\\p{N}])${SALE}(?![\\p{L}\\p{N}])`,
  'isu',
);

const GAMBLING_TAGS = new Set([
  'casino',
  'casinos',
  'gambling',
  'betting',
  'apuestas',
  'poker',
  'slots',
  'jackpot',
  'lottery',
  'loteria',
  'ruleta',
  'bingo',
  'sportsbook',
]);
const ANIMAL_SALE_TAGS = new Set([
  'puppiesforsale',
  'kittensforsale',
  'dogsforsale',
  'animalsforsale',
  'cachorrosenventa',
  'ventadeperros',
  'ventadegatos',
  'perrosenventa',
  'gatosenventa',
]);

const normalizeTag = (tag: string) => tag.replace(/^#/, '').toLowerCase();

/** The first category the post falls in, or null when none of the matchers fire. */
export function excludedCategory(facts: ExclusionFacts): ExcludedCategory | null {
  if (facts.topics?.includes('politics')) return 'politics';
  const tags = (facts.hashtags ?? []).map(normalizeTag);
  if (tags.some((tag) => GAMBLING_TAGS.has(tag))) return 'gambling';
  if (tags.some((tag) => ANIMAL_SALE_TAGS.has(tag))) return 'animal-sales';
  const texts = facts.texts ?? [];
  if (texts.some((text) => GAMBLING.test(text))) return 'gambling';
  if (texts.some((text) => ANIMAL_SALE.test(text))) return 'animal-sales';
  return null;
}
