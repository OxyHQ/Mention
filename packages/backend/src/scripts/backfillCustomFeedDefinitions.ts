/**
 * One-shot migration: derive a composable `definition` for every CustomFeed that
 * predates Phase 3 (custom feeds as definitions).
 *
 * Before Phase 3 a custom feed stored a fixed filter shape
 * (`memberOxyUserIds`/`keywords`/`language`/`includeReplies`/`includeBoosts`/
 * `includeMedia`, owner implicitly excluded from keyword-only feeds). The feed
 * engine now runs a {@link StoredFeedDefinition}. This backfill maps each legacy
 * feed's fields into that definition via the shared {@link legacyCustomFeedToDefinition}
 * mapper (the same mapping the request-time fallback uses), so behaviour is
 * preserved and the two paths can never drift.
 *
 * Idempotent (setting `definition_mode` removes a feed from the selection
 * filter, so the ascending `id` cursor never revisits it and a re-run only fills
 * gaps), batched via a stable ascending `id` page cursor, and item-isolated (a
 * single feed's mapping failure is logged and processing continues, but the
 * completed run exits non-zero so a partial migration cannot look successful).
 * Supports `--dry-run` (report what it would migrate, write nothing).
 *
 * ## The definition spans two tables, so each feed is its own transaction
 *
 * `definition_mode` lives on `custom_feeds` and the three module lists live in
 * `custom_feed_definition_modules`. A feed whose mode was stamped without its
 * modules is WORSE than an un-migrated one: `definitionOf` returns a definition
 * as soon as the mode is non-null, so the request-time legacy fallback stops
 * applying and the feed renders empty instead of rendering from its legacy
 * fields. The batched `bulkWrite` this replaces could not express that coupling
 * at all.
 *
 * Runnable as a Fargate one-shot post-deploy:
 *   bun packages/backend/dist/src/scripts/backfillCustomFeedDefinitions.js
 *   bun packages/backend/dist/src/scripts/backfillCustomFeedDefinitions.js --dry-run
 */

import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import { connectPostgres, getDb } from '../db/postgres';
import { customFeeds } from '../db/schema/feeds';
import { loadFeedRelations, replaceDefinitionModules } from '../db/feeds/customFeedRepository';
import { legacyCustomFeedToDefinition } from '../mtn/feed/definitions/legacyCustomFeed';
import { logger } from '../utils/logger';
import {
  assertAdminRunComplete,
  closeAdminScriptResources,
} from './lib/adminScriptLifecycle';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';

/** Feeds scanned per page (stable ascending `id` cursor pagination). */
const DEFAULT_PAGE_SIZE = 500;

export interface BackfillCustomFeedDefinitionsResult {
  scanned: number;
  updated: number;
  failed: number;
}

/**
 * Backfill definitions over the un-migrated corpus. The caller owns the
 * connection lifecycle, so this is reusable from an in-process caller.
 */
export async function backfillCustomFeedDefinitions(
  opts: { batchSize?: number; dryRun?: boolean } = {},
): Promise<BackfillCustomFeedDefinitionsResult> {
  const pageSize = opts.batchSize ?? DEFAULT_PAGE_SIZE;
  const dryRun = opts.dryRun ?? false;

  // Feeds with no stored definition. Stamping the mode removes a feed from this
  // filter, so the ascending `id` cursor never revisits a migrated feed.
  const baseFilter = isNull(customFeeds.definitionMode);

  let scanned = 0;
  let updated = 0;
  let failed = 0;
  let lastId: string | null = null;

  for (;;) {
    const page = await getDb()
      .select({
        id: customFeeds.id,
        ownerOxyUserId: customFeeds.ownerOxyUserId,
        keywords: customFeeds.keywords,
        language: customFeeds.language,
        includeReplies: customFeeds.includeReplies,
        includeBoosts: customFeeds.includeBoosts,
        includeMedia: customFeeds.includeMedia,
      })
      .from(customFeeds)
      .where(lastId ? and(baseFilter, gt(customFeeds.id, lastId)) : baseFilter)
      .orderBy(asc(customFeeds.id))
      .limit(pageSize);

    if (page.length === 0) break;

    // `memberOxyUserIds` is a child table now, so it is loaded for the whole
    // page rather than projected off each row — the mapper turns it into the
    // `accounts` source and dropping it would migrate a member feed into one
    // with no sources at all.
    const relations = await loadFeedRelations(getDb(), page.map((feed) => feed.id));

    for (const feed of page) {
      scanned += 1;
      try {
        const definition = legacyCustomFeedToDefinition({
          ownerOxyUserId: feed.ownerOxyUserId,
          memberOxyUserIds: relations.get(feed.id)?.memberOxyUserIds ?? [],
          keywords: feed.keywords ?? undefined,
          language: feed.language ?? undefined,
          // NOT NULL DEFAULT true in Postgres, where Mongo left them optional.
          // The mapper only branches on `=== false`, so an absent legacy value
          // and an explicit `true` were already indistinguishable to it.
          includeReplies: feed.includeReplies,
          includeBoosts: feed.includeBoosts,
          includeMedia: feed.includeMedia,
        });
        updated += 1;
        if (dryRun) continue;

        // Mode and modules commit together — see the header. Per feed rather
        // than per page so one unmappable feed cannot roll back the rest.
        await getDb().transaction(async (tx) => {
          await replaceDefinitionModules(tx, feed.id, definition);
          await tx
            .update(customFeeds)
            .set({ definitionMode: definition.mode })
            .where(eq(customFeeds.id, feed.id));
        });
      } catch (error) {
        failed += 1;
        logger.warn('[backfillCustomFeedDefinitions] mapping failed for feed; skipping', {
          id: feed.id,
          reason: error instanceof Error ? error.message : 'unknown',
        });
      }
    }

    lastId = page[page.length - 1].id;
    logger.info(
      `[backfillCustomFeedDefinitions] progress: scanned ${scanned}, updated ${updated}, failed ${failed}`,
    );
  }

  return { scanned, updated, failed };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const dryRun = process.argv.includes('--dry-run');

  try {
    assertAdminMutationAllowed({
      scriptName: 'backfillCustomFeedDefinitions',
      dryRun,
    });
    await connectPostgres();
    logger.info('[backfillCustomFeedDefinitions] connected to PostgreSQL', { dryRun });

    const result = await backfillCustomFeedDefinitions({ dryRun });

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[backfillCustomFeedDefinitions] done${dryRun ? ' (DRY_RUN — no writes)' : ''}: scanned ${result.scanned}, updated ${result.updated}, failed ${result.failed} (${elapsedSeconds}s)`,
    );

    assertAdminRunComplete('backfillCustomFeedDefinitions', {
      failed: result.failed,
    });
  } catch (error) {
    logger.error('[backfillCustomFeedDefinitions] failed', error);
    throw error;
  } finally {
    await closeAdminScriptResources();
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('[backfillCustomFeedDefinitions] unhandled failure', error);
      process.exit(1);
    });
}
