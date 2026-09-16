/**
 * `mention_job_daily_metrics` reads/writes (OxyHQ/Mention#952 Phase E).
 *
 * PRIVACY INVARIANT (issue #952): "no named-viewer trail" — this table has no
 * viewer column at all, by design (`db/schema/jobs.ts`'s own docblock), and
 * every read here returns an AGGREGATE only. Nothing in this file may ever
 * accept or expose a viewer/visitor identity; if a future caller wants
 * per-viewer analytics, that is a different, deliberately-designed feature,
 * not an extension of this one.
 *
 * Atomic upsert-increment, never read-then-write. A page view under
 * concurrent load must never lose an increment to a lost-update race — see
 * `recordJobMetricEvent`.
 */

import { eq, sql } from 'drizzle-orm';
import type { MentionJobMetricEvent, MentionJobMetricsSummary } from '@mention/shared-types';
import { getDb } from '../postgres';
import { mentionJobDailyMetrics } from '../schema/jobs';

/** UTC calendar day, at midnight — the grain `mention_job_daily_metrics.day` stores. */
function utcMidnight(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Record one metric event for `jobId`, for TODAY (UTC). Upserts the day's row
 * and atomically increments the ONE counter column the event names, via
 * `onConflictDoUpdate` with a `sql`-computed value read off the row itself —
 * never `SELECT` then `UPDATE`, which would lose a concurrent increment
 * between the two statements under load (many anonymous viewers hitting
 * `view` on a popular listing at once is exactly the case this has to
 * survive).
 *
 * One statement per event kind rather than a single parameterized query with
 * a computed column key: drizzle's typed `.set()` wants each key spelled out,
 * and a runtime-computed key would need an unsafe cast to satisfy it. This
 * keeps every branch fully typed.
 */
export async function recordJobMetricEvent(jobId: string, event: MentionJobMetricEvent, now = new Date()): Promise<void> {
  const day = utcMidnight(now);
  const db = getDb();
  const target = [mentionJobDailyMetrics.jobId, mentionJobDailyMetrics.day];

  switch (event) {
    case 'view':
      await db
        .insert(mentionJobDailyMetrics)
        .values({ jobId, day, views: 1 })
        .onConflictDoUpdate({ target, set: { views: sql`${mentionJobDailyMetrics.views} + 1` } });
      return;
    case 'apply_start':
      await db
        .insert(mentionJobDailyMetrics)
        .values({ jobId, day, applyStarts: 1 })
        .onConflictDoUpdate({ target, set: { applyStarts: sql`${mentionJobDailyMetrics.applyStarts} + 1` } });
      return;
    case 'external_apply_click':
      await db
        .insert(mentionJobDailyMetrics)
        .values({ jobId, day, externalApplyClicks: 1 })
        .onConflictDoUpdate({
          target,
          set: { externalApplyClicks: sql`${mentionJobDailyMetrics.externalApplyClicks} + 1` },
        });
      return;
    case 'application_completed':
      await db
        .insert(mentionJobDailyMetrics)
        .values({ jobId, day, completedApplications: 1 })
        .onConflictDoUpdate({
          target,
          set: { completedApplications: sql`${mentionJobDailyMetrics.completedApplications} + 1` },
        });
      return;
  }
}

/**
 * The all-time aggregate for one job — summed across every day on record.
 * Privacy-safe by construction: this table carries no viewer dimension to sum
 * over in the first place, so there is no per-visitor breakdown this query
 * could even accidentally produce.
 */
export async function getJobMetricsSummary(jobId: string): Promise<MentionJobMetricsSummary> {
  const [row] = await getDb()
    .select({
      views: sql<string>`coalesce(sum(${mentionJobDailyMetrics.views}), 0)`,
      applyStarts: sql<string>`coalesce(sum(${mentionJobDailyMetrics.applyStarts}), 0)`,
      externalApplyClicks: sql<string>`coalesce(sum(${mentionJobDailyMetrics.externalApplyClicks}), 0)`,
      completedApplications: sql<string>`coalesce(sum(${mentionJobDailyMetrics.completedApplications}), 0)`,
    })
    .from(mentionJobDailyMetrics)
    .where(eq(mentionJobDailyMetrics.jobId, jobId));

  return {
    jobId,
    views: Number(row?.views ?? 0),
    applyStarts: Number(row?.applyStarts ?? 0),
    externalApplyClicks: Number(row?.externalApplyClicks ?? 0),
    completedApplications: Number(row?.completedApplications ?? 0),
  };
}
