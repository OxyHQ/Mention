// A tiny shared echo guard to suppress socket echo updates after local actions

type EchoAction = "like" | "unlike" | "repost" | "unrepost" | "save" | "unsave" | "reply";

const recentActions: Map<string, Record<EchoAction, number>> = new Map();

// Periodically clean up stale entries to prevent unbounded memory growth
const CLEANUP_INTERVAL_MS = 30_000;
const STALE_THRESHOLD_MS = 5_000;

setInterval(() => {
  const now = Date.now();
  for (const [postId, rec] of recentActions.entries()) {
    const allStale = Object.values(rec).every((ts) => now - ts > STALE_THRESHOLD_MS);
    if (allStale) {
      recentActions.delete(postId);
    }
  }
}, CLEANUP_INTERVAL_MS);

export const markLocalAction = (postId: string, action: EchoAction) => {
  const now = Date.now();
  const rec = recentActions.get(postId) || ({} as Record<EchoAction, number>);
  rec[action] = now;
  recentActions.set(postId, rec);
};

// Reduced window since we have optimistic updates - only need to suppress immediate echo
export const wasRecent = (postId: string, action: EchoAction, windowMs: number = 500): boolean => {
  const rec = recentActions.get(postId);
  if (!rec) return false;
  const ts = rec[action];
  if (!ts) return false;
  return Date.now() - ts < windowMs;
};

export type { EchoAction };
