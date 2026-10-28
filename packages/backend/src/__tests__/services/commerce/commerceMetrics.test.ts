import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectPostgres, closePostgres, getDb } from '../../../db/postgres';
import { accountStorefronts, commerceStoreDailyMetrics } from '../../../db/schema/commerce';
import { eq } from 'drizzle-orm';
import { commerceMetricsSummary, recordCommerceMetric } from '../../../services/commerce/metrics';
import { seedPost, postScope, clearPostScope } from '../../helpers/postFixtures';
const scope = postScope('commerce-metrics');
const accountId = 'commerce-metrics-store';
beforeAll(connectPostgres);
afterAll(async () => {
  await clearPostScope(scope);
  await getDb().delete(accountStorefronts).where(eq(accountStorefronts.oxyAccountId, accountId));
  await closePostgres();
});
describe('private commerce interaction totals', () => {
  it('suppresses small samples and uses atomic increments under concurrent opens', async () => {
    const post = await seedPost(scope);
    const target = { kind: 'post' as const, id: post.id };
    await Promise.all(Array.from({ length: 9 }, () => recordCommerceMetric(target, 'open')));
    await recordCommerceMetric(target, 'handoff');
    expect(await commerceMetricsSummary(target)).toMatchObject({
      suppressed: true,
      opens: null,
      handoffs: null,
    });
    await recordCommerceMetric(target, 'open');
    expect(await commerceMetricsSummary(target)).toMatchObject({
      suppressed: false,
      opens: 10,
      handoffs: 1,
    });
  });
  it('excludes old days and deletes store totals when its connection is removed', async () => {
    await getDb()
      .insert(accountStorefronts)
      .values({ oxyAccountId: accountId, mercariaRef: 'mercaria:store:metrics' });
    const target = { kind: 'store' as const, id: accountId };
    const now = new Date('2026-10-28T12:00:00Z');
    await recordCommerceMetric(target, 'open', new Date('2026-09-28T23:59:59Z'));
    await Promise.all(Array.from({ length: 10 }, () => recordCommerceMetric(target, 'open', now)));
    expect(await commerceMetricsSummary(target, now)).toMatchObject({
      suppressed: false,
      opens: 10,
      handoffs: 0,
    });
    await getDb().delete(accountStorefronts).where(eq(accountStorefronts.oxyAccountId, accountId));
    expect(
      await getDb()
        .select()
        .from(commerceStoreDailyMetrics)
        .where(eq(commerceStoreDailyMetrics.oxyAccountId, accountId)),
    ).toEqual([]);
  });
});
