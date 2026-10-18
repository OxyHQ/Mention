import type { ShadowReceiptReader } from './jevReceipt';
import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * What one shadow lane asks. No model: Oxy's decisions profile chooses, and
 * the model that answered is recorded per row (`resolved_model`).
 */
export interface ShadowRelease {
  readonly evaluationVersion: string;
  readonly supportedLanguages: readonly string[];
}

/** Persisted rendition identity, including the FULL body, before truncation. */
export interface ShadowRendition {
  readonly id: string;
  readonly position: number;
  readonly tag: string | null;
  readonly source: 'author' | 'machine';
  readonly body: string;
  readonly articleTitle: string | null;
  readonly articleBody: string | null;
  readonly articleExcerpt: string | null;
}

export interface ShadowSnapshot {
  readonly postId: string;
  readonly actorUri: string | null;
  readonly owner: string | null;
  readonly languages: readonly string[];
  readonly renditions: readonly ShadowRendition[];
}

export function shadowFingerprint(snapshot: ShadowSnapshot): string {
  // Explicit fields: timestamps/counters on posts are not content revisions.
  // Physical rendition ids are replaced even by a semantic no-op write. They
  // must not authorize another paid request, including an edit away and back.
  // Full author text/metadata and canonical language order remain the identity;
  // machine translations are never inference input or a new revision.
  return createHash('sha256')
    .update(
      JSON.stringify([
        snapshot.postId,
        snapshot.actorUri,
        snapshot.owner,
        snapshot.languages,
        snapshot.renditions
          .filter((rendition) => rendition.source === 'author')
          .sort((left, right) => left.position - right.position)
          .map((rendition) => [
            rendition.position,
            rendition.tag,
            rendition.source,
            rendition.body,
            rendition.articleTitle,
            rendition.articleBody,
            rendition.articleExcerpt,
          ]),
      ]),
    )
    .digest('hex');
}

export function shadowAbstention(snapshot: ShadowSnapshot, release: ShadowRelease) {
  const primary = snapshot.renditions.find((rendition) => rendition.position === 0);
  if (!primary?.body.trim() || primary.source !== 'author') return 'no_primary_text' as const;
  if (!snapshot.languages.length) return 'unknown_language' as const;
  if (snapshot.languages.some((language) => !release.supportedLanguages.includes(language))) {
    return 'unsupported_language' as const;
  }
  return null;
}

export function validateShadowRelease(release: ShadowRelease): void {
  if (
    !release.evaluationVersion.trim() ||
    !release.supportedLanguages.length ||
    new Set(release.supportedLanguages).size !== release.supportedLanguages.length ||
    release.supportedLanguages.some((language) => language.length < 2 || language.length > 35)
  ) {
    throw new Error('Shadow evaluation requires an evaluation version and its languages');
  }
}

/**
 * Mention's storage projection of a decisions response, not a copy of the wire
 * contract: the SDK has already validated the response against
 * `@kaana.ai/contracts` and bound its answers to the questions.
 */
const probability = z.number().finite().min(0).max(1);
export const shadowSignalsSchema = z
  .object({
    /** The model that answered (`publisher/model@revision`), as Kaana reported it. */
    resolvedModel: z.string().min(1).max(200),
    // Each topic is an independent proposition; probabilities need not sum to one.
    topics: z
      .array(z.object({ topic: z.string().min(1).max(60), probability }))
      .max(64)
      .refine((topics) => new Set(topics.map((topic) => topic.topic)).size === topics.length),
    languages: z.array(z.string().min(2).max(35)).min(1).max(3),
    languageEvidence: z
      .array(z.object({ language: z.string().min(2).max(35), probability }).strict())
      .min(1)
      .max(3)
      .refine((rows) => new Set(rows.map((row) => row.language)).size === rows.length),
    sdkReceipt: z
      .object({
        requestId: z.string().min(1).max(128),
        routingPolicy: z
          .object({
            routingPolicyId: z.string().min(1),
            policyVersion: z.number().int().positive(),
          })
          .strict(),
        // Measured quantities, verbatim; never money, and absence never means zero.
        usage: z
          .array(z.object({ unit: z.string().min(1), quantity: z.number().min(0) }).strict())
          .optional(),
      })
      .strict(),
    spam: probability,
    repetition: probability,
    feedValue: probability,
  })
  .strict()
  .refine(
    (signals) =>
      signals.languages.length === signals.languageEvidence.length &&
      signals.languages.every(
        (language, index) => signals.languageEvidence[index]?.language === language,
      ),
    'Language evidence must match the canonical language list',
  );
export type ShadowSignals = z.infer<typeof shadowSignalsSchema>;

export interface ShadowEvaluation {
  readonly release: ShadowRelease;
  readonly receiptReader?: ShadowReceiptReader;
  evaluate(input: {
    readonly text: string;
    readonly languages: readonly string[];
    readonly idempotencyKey: string;
    readonly signal: AbortSignal;
  }): Promise<ShadowSignals>;
}

/** Late results are ignored; a timed-out request keeps its original claim ID. */
export async function evaluateShadowWithDeadline(
  evaluation: ShadowEvaluation,
  input: Omit<Parameters<ShadowEvaluation['evaluate']>[0], 'signal'>,
  timeoutMs: number,
): Promise<ShadowSignals> {
  if (timeoutMs <= 0) throw new Error('Shadow batch deadline exhausted');
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error('Shadow evaluation deadline exceeded; cost uncertain'));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      evaluation.evaluate({ ...input, signal: controller.signal }),
      expired,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
