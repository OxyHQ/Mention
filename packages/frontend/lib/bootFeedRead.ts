/**
 * Native starts no boot read: its unscoped feeds are served from SQLite, which
 * already paints the last session's rows on a cold start. See
 * `bootFeedRead.web.ts`.
 */
export function startHomeFeedBootRead(): void {}
