import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import {
  commercePostDailyMetrics as postMetrics,
  commerceStoreDailyMetrics as storeMetrics,
} from '../../db/schema/commerce';

export type CommerceMetricTarget = { kind: 'post'; id: string } | { kind: 'store'; id: string };
export type CommerceMetricEvent = 'open' | 'handoff';
const MINIMUM_OPENS = 10;
const PERIOD_DAYS = 30;

/** Counters measure interactions, not distinct people, sales or ranking signals. */
export async function recordCommerceMetric(
  target: CommerceMetricTarget,
  event: CommerceMetricEvent,
  now = new Date(),
): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  const opens = event === 'open' ? 1 : 0;
  const handoffs = event === 'handoff' ? 1 : 0;
  if (target.kind === 'post') {
    await getDb()
      .insert(postMetrics)
      .values({ postId: target.id, day, opens, handoffs })
      .onConflictDoUpdate({
        target: [postMetrics.postId, postMetrics.day],
        set: {
          opens: sql`${postMetrics.opens} + ${opens}`,
          handoffs: sql`${postMetrics.handoffs} + ${handoffs}`,
        },
      });
  } else {
    await getDb()
      .insert(storeMetrics)
      .values({ oxyAccountId: target.id, day, opens, handoffs })
      .onConflictDoUpdate({
        target: [storeMetrics.oxyAccountId, storeMetrics.day],
        set: {
          opens: sql`${storeMetrics.opens} + ${opens}`,
          handoffs: sql`${storeMetrics.handoffs} + ${handoffs}`,
        },
      });
  }
}

/** Fixed window and suppression prevent arbitrary viewer/date-level drill-down. */
export async function commerceMetricsSummary(target: CommerceMetricTarget, now = new Date()) {
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - PERIOD_DAYS + 1);
  const from = start.toISOString().slice(0, 10);
  const table = target.kind === 'post' ? postMetrics : storeMetrics;
  const predicate =
    target.kind === 'post'
      ? and(
          eq(postMetrics.postId, target.id),
          gte(postMetrics.day, from),
          lte(postMetrics.day, now.toISOString().slice(0, 10)),
        )
      : and(
          eq(storeMetrics.oxyAccountId, target.id),
          gte(storeMetrics.day, from),
          lte(storeMetrics.day, now.toISOString().slice(0, 10)),
        );
  const [row] = await getDb()
    .select({
      opens: sql<string>`coalesce(sum(${table.opens}), 0)`,
      handoffs: sql<string>`coalesce(sum(${table.handoffs}), 0)`,
    })
    .from(table)
    .where(predicate);
  const opens = Number(row?.opens ?? 0);
  const suppressed = opens < MINIMUM_OPENS;
  return {
    periodDays: PERIOD_DAYS,
    minimumOpens: MINIMUM_OPENS,
    suppressed,
    opens: suppressed ? null : opens,
    handoffs: suppressed ? null : Number(row?.handoffs ?? 0),
  };
}
