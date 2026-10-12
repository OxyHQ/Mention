import { buildJevDecisionRequest, FEED_SCORE_LEVELS } from './jevRequest';
import { createJevReceiptReader, type ShadowReceiptAuthority } from './jevReceipt';
import { decisionAnswersMatch, decisionSuccessSchema } from '@oxy.so/contracts';
import type { OxyInferenceClient } from '@oxy.so/core/inference';
import {
  shadowSignalsSchema,
  validateShadowRelease,
  type ShadowEvaluation,
  type ShadowRelease,
} from './jevShadow';

/** Reviewed topic propositions are versioned with the release; never inferred labels. */
export interface ShadowTopic {
  readonly topic: string;
  readonly question: string;
}

export { FEED_SCORE_LEVELS } from './jevRequest';

/**
 * An inert consumer: callers supply an existing SDK client. No credentials,
 * transport, provider selection, production binding, or retry policy lives here.
 * The SDK binds the returned requestId to the Oxy response header. That edge ID
 * is distinct from our claim/idempotency key; decisions do not return receiptId.
 */
export function createJevShadowEvaluation(
  client: Pick<OxyInferenceClient, 'decide'> &
    Partial<Pick<OxyInferenceClient, 'getGenerationRecordByIdempotencyKey'>>,
  releaseInput: ShadowRelease,
  topicInput: readonly ShadowTopic[],
  receiptAuthority?: ShadowReceiptAuthority,
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
    topics.some(
      (topic) => !topic.topic.trim() || topic.topic.length > 60 || !topic.question.trim(),
    ) ||
    !release.supportedLanguages.length ||
    new Set(release.supportedLanguages).size !== release.supportedLanguages.length ||
    release.supportedLanguages.some((language) => language.length < 2 || language.length > 35)
  ) {
    throw new Error('Invalid reviewed shadow question set');
  }
  const readOriginal = client.getGenerationRecordByIdempotencyKey?.bind(client);
  if (receiptAuthority !== undefined && !readOriginal)
    throw new Error('Canonical receipt reader is unavailable');
  const receiptReader =
    receiptAuthority !== undefined && readOriginal
      ? createJevReceiptReader(
          { getGenerationRecordByIdempotencyKey: readOriginal },
          receiptAuthority,
        )
      : undefined;
  return {
    release,
    ...(receiptReader === undefined ? {} : { receiptReader }),
    async evaluate({ text, languages, idempotencyKey, signal }) {
      const request = buildJevDecisionRequest(release, topics, text, languages);
      // Exactly one dispatch. Any failure is quarantined by the existing worker.
      const result = decisionSuccessSchema.parse(
        await client.decide(request, {
          idempotencyKey,
          signal,
          ...(receiptReader?.authority.delegatedUserId === undefined
            ? {}
            : { delegatedUserId: receiptReader.authority.delegatedUserId }),
        }),
      );
      if (
        result.model !== release.model ||
        !decisionAnswersMatch(request, result.data) ||
        result.routingPolicy.routingPolicyId !== release.policyRef ||
        result.routingPolicy.policyVersion !== release.policyVersion
      ) {
        throw new Error('Shadow SDK response does not match the reviewed request and policy');
      }
      const probability = (id: string): number => {
        const answer = result.data.find((candidate) => candidate.id === id);
        if (answer?.kind !== 'noul') throw new Error('Missing independent shadow proposition');
        return answer.probability;
      };
      const score = result.data.find((answer) => answer.id === 'feedScore');
      if (score?.kind !== 'score') throw new Error('Missing ordered feed score');
      return shadowSignalsSchema.parse({
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
