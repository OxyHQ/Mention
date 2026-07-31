import { logger } from '@/lib/logger';

import { refreshTrendsWidget } from './index';

/**
 * When the app should tell the home-screen trends widget to fetch again.
 *
 * The widget refreshes itself on a WorkManager schedule matched to the server's
 * own 30-minute recompute, which is the right cadence when nobody is using the
 * app. It is the wrong cadence in the one case the app can see and the widget
 * cannot: the user is reading trends right now, the batch has just rotated, and
 * the home screen behind them is up to half an hour behind. Nudging then closes
 * that gap to seconds.
 *
 * Everything below exists to keep that nudge rare. `GET /trending` is public and
 * CDN-cached, so a nudge is cheap — but it still wakes a worker and opens a
 * socket, and doing that on every poll tick would be a background fetch every
 * five minutes for a widget the user may not even have.
 */

/**
 * Floor between two nudges.
 *
 * Batches rotate every 30 minutes, so in normal operation this never binds — it
 * is the bound on how badly the app can behave if `recId` ever starts changing
 * more often than the batch does (a CDN serving several cached bodies, say).
 */
export const MIN_TRENDS_WIDGET_SYNC_INTERVAL_MS = 5 * 60_000;

export interface TrendsWidgetSyncDecision {
  /** Batch token from the current `GET /trending` response. */
  recId: string | undefined;
  /** Token of the batch the widget was last nudged for; `null` before the first. */
  lastSyncedRecId: string | null;
  /** When that nudge happened; `null` before the first. */
  lastSyncedAtMs: number | null;
  nowMs: number;
}

/**
 * Whether this response is worth a nudge.
 *
 * Three rules, in order:
 *
 *  1. No `recId` — do nothing. Without a batch token there is no way to tell a
 *     rotation from the same batch being served again, and nudging on every poll
 *     would refetch `/trending` twice over every five minutes to no effect. The
 *     periodic refresh still covers this case; it is only slower.
 *  2. Same `recId` as the last nudge — do nothing. The widget already has this
 *     batch.
 *  3. A new batch, but inside {@link MIN_TRENDS_WIDGET_SYNC_INTERVAL_MS} of the
 *     last nudge — do nothing.
 */
export function shouldSyncTrendsWidget({
  recId,
  lastSyncedRecId,
  lastSyncedAtMs,
  nowMs,
}: TrendsWidgetSyncDecision): boolean {
  if (!recId) return false;
  if (recId === lastSyncedRecId) return false;
  if (lastSyncedAtMs !== null && nowMs - lastSyncedAtMs < MIN_TRENDS_WIDGET_SYNC_INTERVAL_MS) {
    return false;
  }
  return true;
}

let lastSyncedRecId: string | null = null;
let lastSyncedAtMs: number | null = null;

/**
 * Apply {@link shouldSyncTrendsWidget} to a fetched batch and act on it.
 *
 * Call it with every `GET /trending` response the app receives; it decides
 * whether that response is worth telling the widget about.
 *
 * The bookkeeping advances only when a nudge is actually sent, so a response
 * that was skipped for one reason cannot suppress the next one for another.
 */
export function syncTrendsWidget(recId: string | undefined, nowMs: number = Date.now()): void {
  if (!shouldSyncTrendsWidget({ recId, lastSyncedRecId, lastSyncedAtMs, nowMs })) return;

  lastSyncedRecId = recId ?? null;
  lastSyncedAtMs = nowMs;

  // Fire-and-forget, like every other telemetry-shaped write in the app: the
  // home screen being a batch behind is not something to surface to a reader,
  // but it should stay visible in diagnostics.
  void refreshTrendsWidget().catch((error: unknown) => {
    logger.debug('Could not nudge the trends widget', { error });
  });
}
