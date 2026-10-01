import { createHash } from 'node:crypto';
import { z } from 'zod';

/** This is an application release gate, never provider/credential configuration. */
export const JEV_SHADOW_BLOCKERS: readonly string[] = Object.freeze([
  'published_decisions_sdk',
  'reviewed_exact_model_and_oxy_policy',
  'internal_provider_eligibility',
  'privacy_and_zdr',
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
  // Rendition ids distinguish an edit away and back to identical text.
  return createHash('sha256').update(JSON.stringify([
    snapshot.postId, snapshot.actorUri, snapshot.owner, snapshot.languages,
    [...snapshot.renditions].sort((left, right) => left.position - right.position).map(
      rendition => [rendition.id, rendition.position, rendition.tag, rendition.source,
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
  languages: z.array(z.string().min(2).max(35)).max(3),
  spam: probability,
  repetition: probability,
  feedValue: probability,
}).strict();
export type ShadowSignals = z.infer<typeof shadowSignalsSchema>;

/**
 * Domain projection seam for the future published Oxy SDK consumer. It carries
 * no provider options or homemade decisions transport. Production has no binding
 * until that SDK is published and every release gate is independently reviewed.
 */
export interface ShadowEvaluation {
  readonly release: ShadowRelease;
  evaluate(input: {
    readonly text: string;
    readonly languages: readonly string[];
    readonly idempotencyKey: string;
  }): Promise<ShadowSignals>;
}
