import type { ShadowReceiptReader } from './jevReceipt';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { requestIdSchema, routingPolicyReferenceSchema, usageQuantitySchema } from '@oxy.so/contracts';
import type { DecisionSuccess } from '@oxy.so/contracts';

/** This is an application release gate, never provider/credential configuration. */
export const JEV_SHADOW_BLOCKERS: readonly string[] = Object.freeze([
  'published_decisions_sdk',
  'reviewed_exact_model_and_oxy_policy',
  'internal_provider_eligibility',
  'privacy_and_zdr',
  'federated_public_visibility_provenance',
  'semantic_revision_and_receipt_reconciliation',
] as const);

/** No environment switch can bypass the pending independent release reviews. */
export function isJevShadowReleased(): boolean {
  return JEV_SHADOW_BLOCKERS.length === 0;
}

export interface ShadowRelease {
  readonly model: string;
  readonly policyRef: string;
  readonly policyVersion: number;
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
  return createHash('sha256').update(JSON.stringify([
    snapshot.postId, snapshot.actorUri, snapshot.owner, snapshot.languages,
    snapshot.renditions.filter(rendition => rendition.source === 'author')
      .sort((left, right) => left.position - right.position).map(
      rendition => [rendition.position, rendition.tag, rendition.source,
        rendition.body, rendition.articleTitle, rendition.articleBody, rendition.articleExcerpt],
    ),
  ])).digest('hex');
}

export function shadowAbstention(snapshot: ShadowSnapshot, release: ShadowRelease) {
  const primary = snapshot.renditions.find(rendition => rendition.position === 0);
  if (!primary?.body.trim() || primary.source !== 'author') return 'no_primary_text' as const;
  if (!snapshot.languages.length) return 'unknown_language' as const;
  if (snapshot.languages.some(language => !release.supportedLanguages.includes(language))) {
    return 'unsupported_language' as const;
  }
  return null;
}

export function validateShadowRelease(release: ShadowRelease): void {
  if (!/^[^\s/@]+\/[^\s/@]+@[^\s/@]+$/.test(release.model)
    || /@(latest|main|head)$/i.test(release.model)
    || !release.policyRef.trim() || !Number.isSafeInteger(release.policyVersion)
    || release.policyVersion < 1 || !release.evaluationVersion.trim()) {
    throw new Error('Shadow evaluation requires an immutable model, policy and evaluation version');
  }
}

/** Mention's storage projection, not a copy of the SDK decisions wire contract. */
const probability = z.number().finite().min(0).max(1);
export const shadowSignalsSchema = z.object({
  // Each topic is an independent proposition; probabilities need not sum to one.
  topics: z.array(z.object({ topic: z.string().min(1).max(60), probability })).max(64)
    .refine(topics => new Set(topics.map(topic => topic.topic)).size === topics.length),
  languages: z.array(z.string().min(2).max(35)).min(1).max(3),
  languageEvidence: z.array(z.object({ language: z.string().min(2).max(35), probability }).strict()).min(1).max(3)
    .refine(rows => new Set(rows.map(row => row.language)).size === rows.length),
  sdkReceipt: z.object({
    requestId: z.string().refine(value => requestIdSchema.safeParse(value).success),
    routingPolicy: z.custom<DecisionSuccess['routingPolicy']>(value => routingPolicyReferenceSchema.safeParse(value).success),
    // Optional only for synthetic/domain fixtures. The SDK projection always supplies
    // the measured quantities verbatim; absence never means zero cost.
    usage: z.custom<DecisionSuccess['usage']>(value => usageQuantitySchema.array().safeParse(value).success).optional(),
  }).strict(),
  spam: probability,
  repetition: probability,
  feedValue: probability,
}).strict().refine(signals => signals.languages.length === signals.languageEvidence.length
  && signals.languages.every((language, index) => signals.languageEvidence[index]?.language === language),
'Language evidence must match the canonical language list');
export type ShadowSignals = z.infer<typeof shadowSignalsSchema>;

/**
 * Domain projection of the published Oxy SDK. Production has no binding until
 * every release gate is independently reviewed.
 */
/** A local admission refusal before calling the SDK; it cannot represent provider failure. */
export class ShadowAdmissionClosedError extends Error {}

export interface ShadowEvaluation {
  readonly release: ShadowRelease;
  readonly receiptReader?: ShadowReceiptReader;
  /** Optional product gate, checked before and after the SQL claim. */
  isAdmissionOpen?(): boolean;
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
    return await Promise.race([evaluation.evaluate({ ...input, signal: controller.signal }), expired]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
