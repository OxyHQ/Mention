import { z } from 'zod/v4';
import { canonicalizeLanguageTag } from '@mention/shared-types';
import { api } from './api-client.js';
import { unwrapApiResponse } from './api-response.js';

/** Same language parser as the backend request boundary; never infer account preferences. */
export const feedLanguageSchema = z
  .string()
  .max(128)
  .refine((value) => canonicalizeLanguageTag(value) !== null, 'Expected one valid language tag')
  .optional()
  .describe(
    'Explicit request language, e.g. es or en-US (one tag, not a comma-separated list). Used as readability fallback when account languages are unavailable; does not read or change account preferences.',
  );

type FeedQuery = Record<string, string | number | boolean | undefined>;

export function paginationParams(limit?: number, cursor?: string): FeedQuery {
  const q: FeedQuery = {};
  if (limit) q.limit = limit;
  if (cursor) q.cursor = cursor;
  return q;
}

/** Fetch a descriptor-based MTN feed and unwrap the `{ success, data }` envelope. */
export async function fetchMtnFeed(
  descriptor: string,
  options?: { limit?: number; cursor?: string; lang?: string },
): Promise<Record<string, unknown>> {
  const query: FeedQuery = { descriptor, ...paginationParams(options?.limit, options?.cursor) };
  const lang = feedLanguageSchema.parse(options?.lang);
  if (lang !== undefined) query.lang = canonicalizeLanguageTag(lang) ?? undefined;
  const raw = await api.get('/feed/mtn', query);
  return unwrapApiResponse<Record<string, unknown>>(raw);
}
