// A tiny shared echo guard to suppress socket echo updates after local actions

type EchoAction = "like" | "unlike" | "repost" | "unrepost" | "save" | "unsave" | "reply";

const recentActions: Map<string, Record<EchoAction, number>> = new Map();

export const markLocalAction = (postId: string, action: EchoAction) => {
  const now = Date.now();
  const rec = recentActions.get(postId) || ({} as Record<EchoAction, number>);
  rec[action] = now;
  recentActions.set(postId, rec);
};

export const wasRecent = (postId: string, action: EchoAction, windowMs: number = 1500): boolean => {
  const rec = recentActions.get(postId);
  if (!rec) return false;
  const ts = rec[action];
  if (!ts) return false;
  return Date.now() - ts < windowMs;
};

export type { EchoAction };
