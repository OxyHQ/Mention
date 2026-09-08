/**
 * Idempotent cutover for deterministic multilingual trends.
 *
 * Re-derives every post's term space, decorates retained trend history with
 * reviewed concept identity/audience scope, writes explicit story membership,
 * then publishes a fresh batch. No inference service is called.
 *
 *   bun packages/backend/dist/src/scripts/backfillMultilingualTrends.js [--dry-run]
 */

import { asc, eq, gt } from 'drizzle-orm';
import { connectPostgres, getDb } from '../db/postgres';
import { trending } from '../db/schema/discovery';
import { resolveTrendConcept, conceptLabels } from '../services/trending/conceptRegistry';
import { resolveTrendScope } from '../services/trending/trendItems';
import { saveStoryMemberships } from '../services/trending/storyMembership';
import { trendingService } from '../services/TrendingService';
import { logger } from '../utils/logger';
import { rebaselineTrendTerms } from './rebaselineTrendTerms';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';

const PAGE_SIZE = 100;
const SCRIPT_NAME = 'backfillMultilingualTrends';

export interface MultilingualTrendBackfillResult {
  postsScanned: number;
  postsUpdated: number;
  trendsScanned: number;
  trendsUpdated: number;
  membershipsInserted: number;
}

export async function backfillMultilingualTrends(dryRun = false): Promise<MultilingualTrendBackfillResult> {
  const postsResult = await rebaselineTrendTerms({ all: true, dryRun });
  let trendsScanned = 0;
  let trendsUpdated = 0;
  let membershipsInserted = 0;
  let lastId: string | undefined;

  for (;;) {
    const rows = await getDb()
      .select()
      .from(trending)
      .where(lastId ? gt(trending.id, lastId) : undefined)
      .orderBy(asc(trending.id))
      .limit(PAGE_SIZE);
    if (rows.length === 0) break;

    for (const row of rows) {
      trendsScanned += 1;
      const languages = row.languages ?? [];
      const regions = row.regions ?? [];
      const concept = resolveTrendConcept(row.name, languages);
      const patch = {
        scope: resolveTrendScope(languages, regions),
        conceptId: concept?.id ?? null,
        localizedLabels: concept ? conceptLabels(concept) : null,
      };

      if (!dryRun) {
        await getDb().update(trending).set(patch).where(eq(trending.id, row.id));
        membershipsInserted += await saveStoryMemberships([{
          id: row.id,
          name: row.name,
          terms: row.terms?.length ? row.terms : [row.name],
          calculatedAt: row.calculatedAt,
        }]);
      }
      trendsUpdated += 1;
    }

    lastId = rows[rows.length - 1].id;
    logger.info('[backfillMultilingualTrends] progress', {
      trendsScanned,
      trendsUpdated,
      membershipsInserted,
      dryRun,
    });
  }

  if (!dryRun) await trendingService.calculateTrending();
  return {
    postsScanned: postsResult.scanned,
    postsUpdated: postsResult.updated,
    trendsScanned,
    trendsUpdated,
    membershipsInserted,
  };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  try {
    assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun });
    await connectPostgres();
    logger.info('[backfillMultilingualTrends] started', { dryRun });
    logger.info('[backfillMultilingualTrends] done', await backfillMultilingualTrends(dryRun));
  } catch (error) {
    logger.error('[backfillMultilingualTrends] failed', error);
    throw error;
  } finally {
    await closeAdminScriptResources();
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(() => process.exit(1));
}
