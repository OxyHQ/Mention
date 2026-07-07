import { api } from "./api-client.js";
import { unwrapApiResponse } from "./api-response.js";

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
  options?: { limit?: number; cursor?: string },
): Promise<Record<string, unknown>> {
  const query: FeedQuery = { descriptor, ...paginationParams(options?.limit, options?.cursor) };
  const raw = await api.get("/feed/mtn", query);
  return unwrapApiResponse<Record<string, unknown>>(raw);
}
