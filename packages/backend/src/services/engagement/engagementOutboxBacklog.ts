/**
 * How far behind the engagement outbox is.
 *
 * The expiry sweep deletes only processed rows, so work that keeps failing is
 * never lost — it waits, silently, while likes stop reaching federation and
 * notifications. These gauges make the wait visible, and an old enough backlog
 * is logged as an error.
 */

import { count, inArray, min } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { engagementOutbox } from '../../db/schema/outbox';
import { logger } from '../../utils/logger';
import { metrics } from '../../utils/metrics';

/** Retries back off to at most an hour, so older unprocessed work is not merely waiting its turn. */
export const ENGAGEMENT_BACKLOG_ALERT_AGE_MS = 60 * 60 * 1000;

/** Publish the backlog's size and the age of its oldest event. Never rejects. */
export async function reportEngagementOutboxBacklog(now: Date = new Date()): Promise<void> {
  try {
    const [row] = await getDb()
      .select({ events: count(), oldest: min(engagementOutbox.createdAt) })
      .from(engagementOutbox)
      .where(inArray(engagementOutbox.status, ['pending', 'processing']));
    const events = row?.events ?? 0;
    const ageMs = row?.oldest ? Math.max(0, now.getTime() - row.oldest.getTime()) : 0;
    metrics.setGauge('engagement_outbox_backlog_events', events);
    metrics.setGauge('engagement_outbox_oldest_age_seconds', Math.round(ageMs / 1000));
    if (ageMs >= ENGAGEMENT_BACKLOG_ALERT_AGE_MS) {
      logger.error('[EngagementOutbox] unprocessed events are not draining', {
        events,
        oldestAgeSeconds: Math.round(ageMs / 1000),
      });
    }
  } catch (error) {
    logger.warn('[EngagementOutbox] could not read the backlog', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
