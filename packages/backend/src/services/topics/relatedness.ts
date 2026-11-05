/**
 * Topic relatedness from co-occurrence: a pure, storage-free core.
 *
 * Input is counting only: how many items carry each topic (`volumes`), and how
 * many items carry both topics of a pair (`edges`). Nothing here knows what a
 * topic means, and nothing calls a model.
 *
 * The score for a pair is a Beta posterior, not a raw ratio. For the direction
 * A → B the estimate of P(B | A) is `(co + α) / (volume(A) + α + β)`. A raw
 * ratio says "2 of 2 posts" is certain; the prior says two posts are not enough
 * to know, so a relation starts near zero and rises as evidence accumulates.
 *
 * A pair is scored by the SMALLER of its two directions. Mention's topics are
 * asymmetric (every post about a small topic is about a large one, not the
 * reverse), and the weaker direction is the honest strength of the link.
 */

/** The Beta prior over a relation's strength. Default mean 0.01, weight 50. */
export interface RelatednessPrior {
  readonly alpha: number;
  readonly beta: number;
}

export interface RelatednessOptions {
  readonly prior?: RelatednessPrior;
  /** A pair needs at least this many shared items before it may be related. */
  readonly minCooccurrence?: number;
  /** Relations kept per topic, strongest first. */
  readonly topK?: number;
}

/** Items carrying both topics. Each unordered pair appears once. */
export interface CooccurrenceEdge {
  readonly a: string;
  readonly b: string;
  readonly count: number;
}

/** How many items carry each topic. */
export type TopicVolumes = ReadonlyMap<string, number>;

export interface RelatedTopic {
  readonly topic: string;
  readonly score: number;
  readonly cooccurrence: number;
}

export const DEFAULT_RELATEDNESS_PRIOR: RelatednessPrior = { alpha: 0.5, beta: 49.5 };
export const DEFAULT_MIN_COOCCURRENCE = 3;
export const DEFAULT_TOP_K = 20;

/** The posterior mean of P(B | A): shared items over A's items, smoothed by the prior. */
export function posteriorConditional(
  cooccurrence: number,
  volumeOfSource: number,
  prior: RelatednessPrior = DEFAULT_RELATEDNESS_PRIOR,
): number {
  return (cooccurrence + prior.alpha) / (volumeOfSource + prior.alpha + prior.beta);
}

/** Symmetric strength of one pair: the weaker of its two directions. */
export function pairScore(
  cooccurrence: number,
  volumeA: number,
  volumeB: number,
  prior: RelatednessPrior = DEFAULT_RELATEDNESS_PRIOR,
): number {
  return Math.min(
    posteriorConditional(cooccurrence, volumeA, prior),
    posteriorConditional(cooccurrence, volumeB, prior),
  );
}

/**
 * Builds the top-K related topics for every topic that has at least one
 * qualifying pair. Throws on input that breaks the counting invariants instead
 * of guessing: a bad count would otherwise look like a strong relation.
 */
export function buildRelations(
  edges: readonly CooccurrenceEdge[],
  volumes: TopicVolumes,
  options: RelatednessOptions = {},
): Map<string, RelatedTopic[]> {
  const prior = options.prior ?? DEFAULT_RELATEDNESS_PRIOR;
  const minCooccurrence = options.minCooccurrence ?? DEFAULT_MIN_COOCCURRENCE;
  const topK = options.topK ?? DEFAULT_TOP_K;
  validateOptions(prior, minCooccurrence, topK);

  const seen = new Set<string>();
  const candidates = new Map<string, RelatedTopic[]>();

  for (const edge of edges) {
    validateEdge(edge, volumes, seen);
    if (edge.count < minCooccurrence) continue;
    const volumeA = volumes.get(edge.a) as number;
    const volumeB = volumes.get(edge.b) as number;
    const score = pairScore(edge.count, volumeA, volumeB, prior);
    push(candidates, edge.a, { topic: edge.b, score, cooccurrence: edge.count });
    push(candidates, edge.b, { topic: edge.a, score, cooccurrence: edge.count });
  }

  const result = new Map<string, RelatedTopic[]>();
  for (const [topic, related] of candidates) {
    result.set(topic, related.sort(byStrength).slice(0, topK));
  }
  return result;
}

/**
 * The unordered pairs one item contributes. `topics` are the item's topics with
 * a weight each. Duplicates keep their heaviest weight, and an item carrying
 * more than `maxTopics` keeps only its heaviest, so one large item can add at
 * most `maxTopics * (maxTopics - 1) / 2` pairs.
 */
export function pairsFromItem(
  topics: readonly { readonly topic: string; readonly weight: number }[],
  maxTopics = 8,
): [string, string][] {
  if (!Number.isInteger(maxTopics) || maxTopics < 2) {
    throw new Error(`maxTopics must be an integer of at least 2, got ${maxTopics}`);
  }
  const heaviest = new Map<string, number>();
  for (const { topic, weight } of topics) {
    if (!(weight > 0) || !Number.isFinite(weight)) {
      throw new Error(`topic ${topic} needs a positive finite weight, got ${weight}`);
    }
    heaviest.set(topic, Math.max(weight, heaviest.get(topic) ?? 0));
  }
  const kept = [...heaviest]
    .sort(([ta, wa], [tb, wb]) => wb - wa || (ta < tb ? -1 : ta > tb ? 1 : 0))
    .slice(0, maxTopics)
    .map(([topic]) => topic)
    .sort();
  const pairs: [string, string][] = [];
  for (let i = 0; i < kept.length; i += 1) {
    for (let j = i + 1; j < kept.length; j += 1) pairs.push([kept[i], kept[j]]);
  }
  return pairs;
}

function push(map: Map<string, RelatedTopic[]>, key: string, value: RelatedTopic): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Strongest first; ties by topic id, so the output never depends on input order. */
function byStrength(x: RelatedTopic, y: RelatedTopic): number {
  if (y.score !== x.score) return y.score - x.score;
  if (x.topic === y.topic) return 0;
  return x.topic < y.topic ? -1 : 1;
}

function validateOptions(prior: RelatednessPrior, minCooccurrence: number, topK: number): void {
  if (!(prior.alpha > 0) || !(prior.beta > 0)) {
    throw new Error('the Beta prior needs positive alpha and beta');
  }
  if (!Number.isInteger(minCooccurrence) || minCooccurrence < 1) {
    throw new Error(`minCooccurrence must be an integer of at least 1, got ${minCooccurrence}`);
  }
  if (!Number.isInteger(topK) || topK < 1) {
    throw new Error(`topK must be an integer of at least 1, got ${topK}`);
  }
}

function validateEdge(edge: CooccurrenceEdge, volumes: TopicVolumes, seen: Set<string>): void {
  if (edge.a === edge.b) throw new Error(`a topic cannot relate to itself: ${edge.a}`);
  if (!Number.isInteger(edge.count) || edge.count < 1) {
    throw new Error(
      `co-occurrence must be a positive integer, got ${edge.count} for ${edge.a}/${edge.b}`,
    );
  }
  const volumeA = volumes.get(edge.a);
  const volumeB = volumes.get(edge.b);
  if (volumeA === undefined || volumeB === undefined) {
    throw new Error(`no volume recorded for ${edge.a} or ${edge.b}`);
  }
  if (edge.count > Math.min(volumeA, volumeB)) {
    throw new Error(
      `co-occurrence ${edge.count} exceeds the smaller volume for ${edge.a}/${edge.b}`,
    );
  }
  const key = edge.a < edge.b ? `${edge.a}\u0000${edge.b}` : `${edge.b}\u0000${edge.a}`;
  if (seen.has(key)) throw new Error(`duplicate edge ${edge.a}/${edge.b}`);
  seen.add(key);
}
