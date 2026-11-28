import type { Kaana } from '@kaana.ai/sdk' with { 'resolution-mode': 'import' };
import { createJevReceiptReader } from './jevReceipt';
import { buildJevDecisionRequest, FEED_SCORE_LEVELS } from './jevRequest';
import {
  shadowSignalsSchema,
  validateShadowRelease,
  type ShadowEvaluation,
  type ShadowRelease,
  type ShadowTopic,
} from './jevShadow';

/** The part of the Kaana client Jev uses; the receipt read is optional. */
export interface JevKaanaClient {
  readonly decisions: Pick<Kaana['decisions'], 'create'>;
  readonly generations?: Pick<Kaana['generations'], 'getByIdempotencyKey'>;
}

/**
 * An inert consumer: callers supply an existing Kaana client. No credentials,
 * transport, provider selection or retry policy lives here. The SDK validates
 * the response against `@kaana.ai/contracts` and refuses answers that do not
 * answer these questions; Kaana's requestId is distinct from our claim key.
 */
export function createJevShadowEvaluation(
  client: JevKaanaClient,
  releaseInput: ShadowRelease,
  topicInput: readonly ShadowTopic[],
): ShadowEvaluation {
  validateShadowRelease(releaseInput);
  const release = Object.freeze({
    ...releaseInput,
    supportedLanguages: Object.freeze([...releaseInput.supportedLanguages]),
  });
  const topics = topicInput.map((topic) => Object.freeze({ ...topic }));
  if (
    topics.length > 64 ||
    new Set(topics.map((topic) => topic.topic)).size !== topics.length ||
    topics.some((topic) => !topic.topic.trim() || topic.topic.length > 60 || !topic.question.trim())
  ) {
    throw new Error('Invalid reviewed shadow question set');
  }
  const generations = client.generations;
  return {
    release,
    ...(generations === undefined
      ? {}
      : { receiptReader: createJevReceiptReader({ generations }) }),
    async evaluate({ text, languages, idempotencyKey, signal }) {
      const request = buildJevDecisionRequest(release, topics, text, languages);
      // Exactly one dispatch. Any failure is settled by the worker, never retried.
      const result = await client.decisions.create(request, { idempotencyKey, signal });
      const probability = (id: string): number => {
        const answer = result.data.find((candidate) => candidate.id === id);
        if (answer?.kind !== 'noul') throw new Error('Missing independent shadow proposition');
        return answer.probability;
      };
      const score = result.data.find((answer) => answer.id === 'feedScore');
      if (score?.kind !== 'score') throw new Error('Missing ordered feed score');
      return shadowSignalsSchema.parse({
        resolvedModel: result.model,
        topics: topics.map((topic, index) => ({
          topic: topic.topic,
          probability: probability(`topic:${index}`),
        })),
        // Canonical language evidence is retained, never thresholded into new labels.
        languages: [...languages],
        languageEvidence: languages.map((language, index) => ({
          language,
          probability: probability(`language:${index}`),
        })),
        spam: probability('spam'),
        repetition: probability('repetition'),
        feedValue: score.mean / (FEED_SCORE_LEVELS.length - 1),
        sdkReceipt: {
          requestId: result.requestId,
          routingPolicy: result.routingPolicy,
          usage: result.usage,
        },
      });
    },
  };
}
