/**
 * Build every SEO sitemap when the cached catalog is due (`services/seoSitemap.ts`).
 *
 * Run as a scheduled one-shot ECS task from the live `mention` task definition
 * with this command (oxy-infra `app-mention-sitemaps.tf`), never inside a task
 * serving requests: the build streams every eligible post and gzips 64 shards,
 * and on the scheduler leader it pinned a 0.5 vCPU serving task at 100% CPU
 * (that task died during the 07:42Z build on 2026-10-19). The schedule fires
 * more often than the six-hour refresh,
 * and due-ness is read from the catalog in Redis, so a missed or failed run is
 * retried by the next one and a flushed cache is rebuilt within one interval.
 * A failure exits non-zero and leaves the previous sitemaps serving.
 *
 * The cache is fail-open — an unready client reads as a miss and drops writes —
 * which suits a request and would make this task build everything and persist
 * nothing, then exit 0. So it waits for Redis before reading the catalog, and
 * reads the catalog back after writing it.
 *
 *   bun packages/backend/dist/src/scripts/buildSitemaps.js   (production image)
 *   bun run sitemaps:build                                  (packages/backend, local)
 */

import { once } from 'node:events';
import { connectPostgres } from '../db/postgres';
import { buildSitemapsIfDue, sitemapsAreDue } from '../services/seoSitemap';
import { logger } from '../utils/logger';
import { getRedisClient } from '../utils/redis';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';

const SCRIPT_NAME = 'buildSitemaps';
const REDIS_READY_TIMEOUT_MS = 30_000;

async function main(): Promise<void> {
  await connectPostgres();
  const redis = getRedisClient();
  if (!redis.isReady) {
    await once(redis, 'ready', { signal: AbortSignal.timeout(REDIS_READY_TIMEOUT_MS) });
  }
  const report = await buildSitemapsIfDue();
  if (!report) {
    logger.info(`[${SCRIPT_NAME}] sitemaps are fresh; nothing to build`);
    return;
  }
  if (await sitemapsAreDue()) {
    throw new Error('the built catalog did not persist to Redis');
  }
  logger.info(`[${SCRIPT_NAME}] built every sitemap`, { ...report });
}

if (require.main === module) {
  main()
    .then(async () => {
      await closeAdminScriptResources();
      process.exit(0);
    })
    .catch(async (error) => {
      logger.error(`[${SCRIPT_NAME}] failed; the previous sitemaps keep serving`, {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      await closeAdminScriptResources().catch(() => undefined);
      process.exit(1);
    });
}
