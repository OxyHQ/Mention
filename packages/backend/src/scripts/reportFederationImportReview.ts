/** Read-only triage. No mutation mode, classifier threshold or deletion operation. */
import { sql } from 'drizzle-orm';
import { connectPostgres, closePostgres, getDb, type Database } from '../db/postgres';
import type { FederationImportReason } from '../db/schema/federationImports';

interface ReviewEvidence extends Record<string, unknown> {
  id: string;
  url: string | null;
  initialReason: FederationImportReason | null;
  reasons: FederationImportReason[];
  hasProtocolFollow: boolean;
  hasReferences: boolean;
  hasEngagement: boolean;
  hasSaves: boolean;
  hasViews: boolean;
  hasContext: boolean;
}

export interface FederationImportReviewRow extends ReviewEvidence {
  protectionReasons: string[];
  disposition: 'protected';
  discoveryOnlyWithoutKnownNeed: boolean;
}

/**
 * A bounded, consistent READ ONLY snapshot. Protocol follow rows are positive
 * evidence only: their absence cannot prove absence in Oxy's authoritative graph.
 * Accordingly this report cannot authorize cleanup even for discovery-only rows.
 */
export async function reportFederationImportReview(
  options: { limit?: number; afterId?: string; postIds?: readonly string[] } = {},
  db: Database = getDb(),
): Promise<{ dryRun: true; rows: FederationImportReviewRow[]; nextCursor: string | null }> {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('limit must be 1–500');
  if (options.postIds && options.postIds.length > 500) throw new Error('At most 500 post IDs');
  const requestedIds = options.postIds;
  if (requestedIds?.length === 0) return { dryRun: true, rows: [], nextCursor: null };
  const evidence = await db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout = '15s'`);
    return tx.execute<ReviewEvidence>(sql`
      WITH page AS (
        SELECT p.id, p.federation_url, p.federation_actor_uri, p.parent_post_id,
               p.quote_of, p.boost_of, p.thread_id, p.is_reply, p.stats_views_count,
               p.community_oxy_user_id, p.stats_likes_count, p.stats_boosts_count,
               p.stats_comments_count
        FROM posts p
        WHERE p.federation_actor_uri IS NOT NULL AND p.visibility = 'public'
          AND p.status = 'published'
          ${options.afterId ? sql`AND p.id > ${options.afterId}` : sql``}
          ${
            requestedIds
              ? sql`AND p.id IN (${sql.join(
                  requestedIds.map((id) => sql`${id}`),
                  sql`, `,
                )})`
              : sql``
          }
        ORDER BY p.id LIMIT ${limit}
      )
      SELECT p.id, p.federation_url AS url, origin.initial_reason AS "initialReason",
        ARRAY(SELECT r.reason FROM federation_post_import_reasons r WHERE r.post_id = p.id ORDER BY r.reason) AS reasons,
        EXISTS(SELECT 1 FROM federated_follows f WHERE f.remote_actor_uri = p.federation_actor_uri
          AND f.direction = 'outbound' AND f.status = 'accepted') AS "hasProtocolFollow",
        (EXISTS(SELECT 1 FROM posts ref WHERE ref.parent_post_id = p.id)
          OR EXISTS(SELECT 1 FROM posts ref WHERE ref.quote_of = p.id)
          OR EXISTS(SELECT 1 FROM posts ref WHERE ref.boost_of = p.id)
          OR EXISTS(SELECT 1 FROM posts ref WHERE ref.thread_id = p.id AND ref.id <> p.id)) AS "hasReferences",
        (EXISTS(SELECT 1 FROM likes l WHERE l.post_id = p.id)
          OR EXISTS(SELECT 1 FROM feed_interactions interaction WHERE interaction.post_uri = p.id)
          OR p.stats_likes_count > 0 OR p.stats_boosts_count > 0
          OR p.stats_comments_count > 0) AS "hasEngagement",
        EXISTS(SELECT 1 FROM bookmarks b WHERE b.post_id = p.id) AS "hasSaves",
        p.stats_views_count > 0 AS "hasViews",
        (p.parent_post_id IS NOT NULL OR p.quote_of IS NOT NULL OR p.boost_of IS NOT NULL
          OR p.thread_id IS NOT NULL OR p.is_reply OR p.community_oxy_user_id IS NOT NULL) AS "hasContext"
      FROM page p LEFT JOIN federation_post_imports origin ON origin.post_id = p.id
      ORDER BY p.id
    `);
  });
  const rows = evidence.map((row): FederationImportReviewRow => {
    const protectionReasons = ['authoritative_follow_graph_unverified'];
    if (!row.initialReason || row.initialReason === 'unknown_outbox')
      protectionReasons.push('unknown_initial_import');
    if (row.reasons.some((reason) => reason !== 'discovery_backfill'))
      protectionReasons.push('required_or_requested_import');
    if (row.hasProtocolFollow) protectionReasons.push('accepted_protocol_follow');
    if (row.hasReferences) protectionReasons.push('referenced_by_post');
    if (row.hasEngagement) protectionReasons.push('engagement');
    if (row.hasSaves) protectionReasons.push('saved');
    if (row.hasViews) protectionReasons.push('viewed');
    if (row.hasContext) protectionReasons.push('conversation_or_community_context');
    return {
      ...row,
      protectionReasons,
      disposition: 'protected',
      discoveryOnlyWithoutKnownNeed:
        row.initialReason === 'discovery_backfill' &&
        row.reasons.length > 0 &&
        row.reasons.every((reason) => reason === 'discovery_backfill') &&
        !row.hasProtocolFollow &&
        !row.hasReferences &&
        !row.hasEngagement &&
        !row.hasSaves &&
        !row.hasViews &&
        !row.hasContext,
    };
  });
  return {
    dryRun: true,
    rows,
    nextCursor: rows.length === limit ? (rows.at(-1)?.id ?? null) : null,
  };
}

if (require.main === module) {
  (async () => {
    try {
      await connectPostgres();
      const result = await reportFederationImportReview({
        limit: Number(process.env.FEDERATION_REVIEW_LIMIT ?? 100),
        afterId: process.env.FEDERATION_REVIEW_AFTER_ID,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally {
      await closePostgres();
    }
  })().catch((error: unknown) => {
    process.stderr.write(
      `Federation import review failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
