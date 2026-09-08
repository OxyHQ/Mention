/**
 * Deterministic multilingual concept identity for trending.
 *
 * Terms remain the words authors wrote; a concept is the language-independent
 * identity several terms may express.  This module deliberately contains no
 * inference or translation.  Every equivalence is reviewable source data and
 * an unknown term simply remains unresolved.
 */

export type TrendConceptKind = 'topic' | 'entity' | 'organization' | 'place' | 'product';

export interface TrendConceptDefinition {
  id: string;
  kind: TrendConceptKind;
  labels: Readonly<Record<string, string>>;
  aliases: Readonly<Record<string, readonly string[]>>;
  topic?: string;
}

const DEFINITIONS: readonly TrendConceptDefinition[] = [
  {
    id: 'entity:donald-trump',
    kind: 'entity',
    labels: { en: 'Donald Trump', es: 'Donald Trump', fr: 'Donald Trump', de: 'Donald Trump' },
    aliases: {
      und: ['donald trump', 'trump'],
      en: ['president trump'],
      es: ['presidente trump'],
      fr: ['président trump'],
      de: ['präsident trump'],
    },
    topic: 'politics',
  },
  {
    id: 'place:white-house',
    kind: 'place',
    labels: { en: 'White House', es: 'Casa Blanca', fr: 'Maison-Blanche', de: 'Weißes Haus' },
    aliases: {
      en: ['white house'],
      es: ['casa blanca'],
      fr: ['maison blanche', 'maison-blanche'],
      de: ['weißes haus', 'weisses haus'],
    },
    topic: 'politics',
  },
  {
    id: 'topic:petroleum',
    kind: 'topic',
    labels: { en: 'Oil', es: 'Petróleo', fr: 'Pétrole', de: 'Erdöl', it: 'Petrolio', pt: 'Petróleo' },
    aliases: {
      en: ['oil', 'crude oil'],
      es: ['petróleo', 'petroleo', 'crudo'],
      fr: ['pétrole', 'petrole'],
      de: ['erdöl', 'erdoel'],
      it: ['petrolio'],
      pt: ['petróleo', 'petroleo'],
    },
    topic: 'business',
  },
  {
    id: 'product:fanta',
    kind: 'product',
    labels: { und: 'Fanta' },
    aliases: { und: ['fanta'] },
    topic: 'food',
  },
];

const normalize = (value: string): string => value.trim().toLocaleLowerCase().replace(/[-_]+/g, ' ');

const aliasIndex = new Map<string, TrendConceptDefinition>();
for (const definition of DEFINITIONS) {
  for (const [language, aliases] of Object.entries(definition.aliases)) {
    for (const alias of aliases) aliasIndex.set(`${language}\u0000${normalize(alias)}`, definition);
  }
}

/** Resolve only an explicitly registered alias; no guessed translation. */
export function resolveTrendConcept(
  term: string,
  languages: readonly string[] = [],
): TrendConceptDefinition | undefined {
  const normalized = normalize(term);
  for (const language of languages) {
    const match = aliasIndex.get(`${language.toLowerCase()}\u0000${normalized}`);
    if (match) return match;
  }
  return aliasIndex.get(`und\u0000${normalized}`);
}

/** Best reviewed label for an audience, falling back to the corpus spelling. */
export function localizedConceptLabel(
  concept: TrendConceptDefinition,
  language: string,
  fallback: string,
): string {
  return concept.labels[language] ?? concept.labels.und ?? concept.labels.en ?? fallback;
}

/** Labels safe to persist on a trend row. */
export function conceptLabels(
  concept: TrendConceptDefinition | undefined,
): Record<string, string> {
  return concept ? { ...concept.labels } : {};
}
