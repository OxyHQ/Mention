import { createHash } from 'node:crypto';
import type { StoredPostContent } from '@mention/shared-types';
import { z } from 'zod';
import { JEV_MAX_TEXT_LENGTH } from './jevRequest';
import { CONTENT_CLASSIFICATIONS } from '@oxy.so/contracts';
import { extractUrls } from '../../utils/extractUrls';
import { requiresContentWarning, type FeedSafetyPostShape } from '../../mtn/feed/feedSafety';

export const POST_SAFETY_ASSESSMENT_VERSION = 1;

/** Source flags restrict a reviewed result; only current worker evidence can grant general. */
export function postSafetyClassification(
  post: SafetyMaterialPost & FeedSafetyPostShape,
  assessment?: {
    materialDigest: string;
    rating: (typeof CONTENT_CLASSIFICATIONS)[number];
    assessmentVersion: number;
  },
): (typeof CONTENT_CLASSIFICATIONS)[number] {
  if (requiresContentWarning(post)) return 'mature';
  if (!assessment || assessment.assessmentVersion !== POST_SAFETY_ASSESSMENT_VERSION)
    return 'unrated';
  const material = postSafetyMaterial(post);
  if (!material.text || assessment.materialDigest !== material.digest) return 'unrated';
  return assessment.rating;
}
/** The worker may omit a verdict, but it cannot invent another interpretation of it. */
export const safetyVerdictSchema = z
  .object({ classification: z.enum(CONTENT_CLASSIFICATIONS) })
  .strict();

export interface SafetyMaterialPost {
  content?: Partial<StoredPostContent>;
  quoteOf?: unknown;
  boostOf?: unknown;
  parentPostId?: unknown;
  hashtags?: string[];
}

function stableMaterial(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableMaterial);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stableMaterial(child)]),
    );
  return value;
}

/** All visible material and reference IDs are bound, including material this worker cannot assess. */
export function postSafetyMaterial(post: SafetyMaterialPost): {
  digest: string;
  text: string | null;
} {
  const content = post.content ?? {};
  const poll = content.poll
    ? {
        question: content.poll.question,
        options: content.poll.options,
        endTime: content.poll.endTime,
      }
    : null;
  const material = {
    ...content,
    hashtags: post.hashtags ?? [],
    poll,
    quoteOf: post.quoteOf ?? null,
    boostOf: post.boostOf ?? null,
    parentPostId: post.parentPostId ?? null,
  };
  const digest = createHash('sha256')
    .update(JSON.stringify(stableMaterial(material)))
    .digest('hex');
  // Never infer a safety rating from a media caption, external card or incomplete article.
  if (
    content.media?.length ||
    content.attachments?.length ||
    content.sources?.length ||
    content.event ||
    content.room ||
    content.podcast ||
    content.job ||
    content.location ||
    (content.pollId && !content.poll) ||
    (content.article && !content.article.body) ||
    content.variants?.some(
      (variant) => variant.media?.length || (variant.article && !variant.article.body),
    )
  )
    return { digest, text: null };
  const text = JSON.stringify({
    hashtags: post.hashtags ?? [],
    renditions: (content.variants ?? []).map((variant) => ({
      tag: variant.tag,
      text: variant.text,
      article: variant.article ?? null,
    })),
    article: content.article ?? null,
    poll,
  });
  const hasText =
    content.variants?.some((variant) => variant.text.trim()) ||
    content.article?.body?.trim() ||
    content.poll?.question.trim();
  const visibleTexts = [
    ...(post.hashtags ?? []),
    ...(content.variants ?? []).flatMap((variant) => [
      variant.text,
      variant.article?.title,
      variant.article?.body,
      variant.article?.excerpt,
    ]),
    content.article?.title,
    content.article?.body,
    content.article?.excerpt,
    content.poll?.question,
    ...(content.poll?.options ?? []),
  ].filter((value): value is string => typeof value === 'string');
  // Linked destinations and article markup with embedded resources have not been assessed.
  if (
    !hasText ||
    text.length > JEV_MAX_TEXT_LENGTH ||
    visibleTexts.some((value) => extractUrls(value).length > 0) ||
    /(?:!?\[[^\]]*\]\s*\(|<\s*(?:img|video|audio|iframe)\b)/i.test(text)
  )
    return { digest, text: null };
  return { digest, text };
}
