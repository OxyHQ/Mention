import { PostVisibility } from "@mention/shared-types";

/** Unwrap `{ success, data }` MTN/API envelopes. */
export function unwrapApiResponse<T = Record<string, unknown>>(raw: unknown): T {
  if (typeof raw !== "object" || raw === null) {
    return raw as T;
  }
  const obj = raw as Record<string, unknown>;
  if (obj.success === true && typeof obj.data === "object" && obj.data !== null) {
    return obj.data as T;
  }
  if (typeof obj.post === "object" && obj.post !== null) {
    return obj.post as T;
  }
  return obj as T;
}

/** Map MCP visibility aliases to backend PostVisibility values. */
export function normalizeVisibility(
  visibility?: "public" | "private" | "followers" | "followers_only" | "mentioned",
): PostVisibility | undefined {
  if (!visibility) return undefined;
  if (visibility === "followers" || visibility === "followers_only") {
    return PostVisibility.FOLLOWERS_ONLY;
  }
  if (visibility === "mentioned") {
    return PostVisibility.PRIVATE;
  }
  if (visibility === "private") {
    return PostVisibility.PRIVATE;
  }
  return PostVisibility.PUBLIC;
}
