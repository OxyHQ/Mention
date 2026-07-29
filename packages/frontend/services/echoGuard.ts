// A tiny shared echo guard to suppress socket echo updates after local actions

type EchoAction = "like" | "unlike" | "downvote" | "boost" | "unboost" | "save" | "unsave" | "reply";

const recentActions: Map<string, Record<EchoAction, number>> = new Map();

// Periodically clean up stale entries to prevent unbounded memory growth
const CLEANUP_INTERVAL_MS = 30_000;
const STALE_THRESHOLD_MS = 5_000;

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [postId, rec] of recentActions.entries()) {
    const allStale = Object.values(rec).every((ts) => now - ts > STALE_THRESHOLD_MS);
    if (allStale) {
      recentActions.delete(postId);
    }
  }
}, CLEANUP_INTERVAL_MS);

// Housekeeping must never be the reason a process stays alive. On Node (Jest)
// a referenced interval on a module-level singleton holds the event loop open
// forever, which is why importing anything that reaches this module — the whole
// posts/socket graph — used to hang the test run instead of failing. RN/web
// return a numeric handle with no `unref`, so the optional call no-ops there.
cleanupTimer.unref?.();

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
