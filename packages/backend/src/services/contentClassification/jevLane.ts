import { kaanaClient } from '../../utils/kaana';
import { createJevShadowEvaluation, type JevKaanaClient } from './jevSdk';
import type { ShadowEvaluation, ShadowRelease, ShadowTopic } from './jevShadow';

/**
 * The continuous Jev shadow lane (docs/jev-shadow-evaluation.md).
 *
 * Bump {@link JEV_EVALUATION_VERSION} when the questions, languages or
 * instructions change: a post is evaluated once per version and revision.
 */
export const JEV_EVALUATION_VERSION = 'mention-jev-shadow/2026-10-19.1';

/**
 * Paid calls per UTC day, counted from today's claims. Below the 2000/day cap
 * Oxy holds for the `mention-kaana-decisions` relationship, so Mention stops
 * before Oxy has to refuse it.
 */
export const JEV_SHADOW_DAILY_LIMIT = 1500;

/**
 * The languages Mention's readers write most. TypeSafe trains Jev primarily on
 * English and handles other languages less accurately, so shadow analysis must
 * be split by `languages`; posts in any other language abstain for free.
 */
const JEV_RELEASE: ShadowRelease = Object.freeze({
  evaluationVersion: JEV_EVALUATION_VERSION,
  supportedLanguages: Object.freeze(['en', 'es', 'ca', 'pt', 'fr', 'de', 'it']),
});

/** No topic propositions until a reviewed list exists (ranking use is a later step). */
const JEV_TOPICS: readonly ShadowTopic[] = Object.freeze([]);

/** The shared Kaana client, loaded on first use (the SDK is ESM-only). */
const kaana = {
  decisions: {
    create: async (request, options) => (await kaanaClient()).decisions.create(request, options),
  },
  generations: {
    getByIdempotencyKey: async (key, options) =>
      (await kaanaClient()).generations.getByIdempotencyKey(key, options),
  },
} satisfies Required<JevKaanaClient>;

/**
 * The lane's evaluator. Actual workload attestation and request policy are
 * checked by the shared client when it dispatches, including local role/SSO.
 */
export function createJevLane(): ShadowEvaluation | undefined {
  return createJevShadowEvaluation(kaana, JEV_RELEASE, JEV_TOPICS);
}
