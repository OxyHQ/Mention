/**
 * One-shot admin backfill: qualify the bare `@handle`s inside ALREADY-STORED
 * federated post bodies.
 *
 * A handle written on another network means the account THERE. Ingest now stores
 * `@Julio_Rodr_@x.com`, but a post body is written ONCE — unlike an actor's bio,
 * which every refresh rewrites — so everything imported before that change keeps
 * a bare `@Julio_Rodr_`, which reads as a LOCAL name and links to whoever holds
 * it here. This repairs the history.
 *
 * IT USES THE SAME FUNCTION THE INGEST PATH USES. `qualifyBareHandles` scans with
 * the shared entity scanner, so a URL's `@handle`, an email and a mention already
 * hydrated into a placeholder are excluded by the one definition rather than by a
 * rule invented for the backfill — which is the only way a backfill and a live
 * path can be guaranteed to agree. It is idempotent (asserted in the scanner's
 * own suite), so a re-run is a no-op and an interrupted run is safe to resume.
 *
 * THE DOMAIN IS THE IDENTITY'S, NEVER THE HOST THE COPY ARRIVED THROUGH. A
 * re-labelled bridge actor stores `domain: mastox.eu` while its identity is on
 * `x.com`; `identityDomainOfActor` reads `networkAcct` first for exactly that
 * reason. Getting this backwards would pin every handle in every historical body
 * onto a bridge hostname.
 *
 * ── WHY THIS FILE IS POSTGRES ────────────────────────────────────────────────
 *
 * It arrived from `main` writing Mongo, and merged into the port with ZERO
 * conflicts and ZERO type errors — because `models/Post` and
 * `models/FederatedActor` are among the models the port KEPT, so nothing failed
 * to resolve. Post-cutover it would have reported a real, truthful write count
 * about a store nothing reads.
 *
 * That matters more than an ordinary wrong-store bug, because of what the
 * counting below is FOR. The reporting exists precisely so a silent no-op is
 * visible — the first production run logged 213 written while modifying nothing.
 * Pointed at the abandoned store, that same instrumentation reports `written: N`
 * and N is TRUE: it really did write N rows, to a table the app no longer serves
 * from. A fabricated number invites suspicion; a correct number about the wrong
 * subject does not, and it survives every review that only checks whether the
 * metric is accurate. The defence becomes the concealment.
 *
 * SELECTION:
 *  1. Variants whose post's author has a `federated_actors` row — a local user's
 *     post is never touched, because a bare handle there already means a local
 *     account.
 *  2. Of those, only bodies the qualifier actually CHANGES. A body whose handles
 *     are already qualified, or which has none, is not written at all.
 *
 * SAFETY:
 *  1. `BACKFILL_DRY_RUN` defaults to `'true'`. It reports what WOULD change,
 *     with before/after samples, and writes nothing. Only `=false` writes.
 *  2. `BACKFILL_MAX` (default 5000) caps the run; overflow is reported, never
 *     silently dropped.
 *  3. Every write is a targeted update of ONE variant row by its own primary key.
 *     No other column is read back and re-saved, so a concurrent edit elsewhere
 *     on the post cannot be clobbered by this script.
 *  4. An actor with no resolvable identity domain is SKIPPED, not guessed at.
 *
 * Runnable as a Fargate one-shot:
 *   BACKFILL_DRY_RUN=false CONFIRM_ADMIN_MUTATION=backfillFederatedHandleQualification \
 *   bun packages/backend/dist/src/scripts/backfillFederatedHandleQualification.js
 */

import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { qualifyBareHandles } from '@mention/shared-types/textEntities';
import { logger } from '../utils/logger';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { postContentVariants } from '../db/schema/postContent';
import { federatedActors } from '../db/schema/federation';
import { identityDomainOfActor } from '../connectors/activitypub/identityDomain';

const SCRIPT_NAME = 'backfillFederatedHandleQualification';

export interface HandleQualificationResult {
  scanned: number;
  /** Bodies the qualifier would rewrite. */
  changed: number;
  /** Rows Postgres REPORTED updating — never "we called update". */
  written: number;
  matched: number;
  /** Changed rows but wrote none: the silent no-op this reporting exists for. */
  noOpWrites: boolean;
  samples: Array<{ id: string; before: string; after: string }>;
}

/**
 * The backfill itself. The CALLER owns the connection lifecycle, which is what
 * makes this runnable in-process from a test against real rows — the property
 * the Mongo original never had, and the reason its wrong-store bug could only
 * have been caught by reading the file.
 */
export async function backfillFederatedHandleQualification(
  opts: { dryRun?: boolean; max?: number } = {},
): Promise<HandleQualificationResult> {
  const DRY_RUN = opts.dryRun ?? true;
  const MAX = opts.max ?? 5000;

  const db = getDb();

  // One pass over the actors, so the per-variant work is a map lookup rather
  // than a query. `oxyUserId` is what a post is authored by.
  const actors = await db
    .select({
      oxyUserId: federatedActors.oxyUserId,
      networkAcct: federatedActors.networkAcct,
      domain: federatedActors.domain,
    })
    .from(federatedActors)
    .where(isNotNull(federatedActors.oxyUserId));

  const domainByUser = new Map<string, string>();
  for (const actor of actors) {
    const domain = identityDomainOfActor(actor);
    if (actor.oxyUserId && domain) domainByUser.set(actor.oxyUserId, domain);
  }
  logger.info('[Backfill] federated authors with a resolvable identity domain', {
    actors: actors.length,
    usable: domainByUser.size,
  });

  let scanned = 0;
  let changed = 0;
  let written = 0;
  let matched = 0;
  const samples: Array<{ id: string; before: string; after: string }> = [];

  if (domainByUser.size > 0) {
    // The VARIANT is the unit, not the post: `post_content_variants` is one row
    // per rendition, so a post with three translations is three candidate bodies
    // and each is written on its own primary key. The Mongo version rewrote a
    // whole `content.variants` array in one `$set`, which is what made a stale
    // spread able to carry the original text back in — a shape this schema
    // cannot express.
    const rows = await db
      .select({
        id: postContentVariants.id,
        postId: postContentVariants.postId,
        body: postContentVariants.body,
        oxyUserId: posts.oxyUserId,
      })
      .from(postContentVariants)
      .innerJoin(posts, eq(posts.id, postContentVariants.postId))
      .where(and(
        isNotNull(posts.oxyUserId),
        inArray(posts.oxyUserId, [...domainByUser.keys()]),
      ))
      .limit(MAX);

    for (const row of rows) {
      scanned += 1;
      const domain = row.oxyUserId ? domainByUser.get(row.oxyUserId) : undefined;
      if (!domain) continue;

      const next = qualifyBareHandles(row.body, domain);
      if (next === row.body) continue;

      changed += 1;
      if (samples.length < 5) {
        samples.push({
          id: row.postId,
          before: row.body.slice(0, 120),
          after: next.slice(0, 120),
        });
      }
      if (!DRY_RUN) {
        // Counted from what POSTGRES REPORTS, never from "we called update".
        // `returning()` yields one row per row actually updated, so a write that
        // matched nothing — a variant deleted since the read above — counts as
        // matched: 0 rather than as work done. The Mongo original made this
        // distinction with `modifiedCount`; the reason for making it is the
        // same, and it is why the first run logged 213 written while modifying
        // nothing.
        const updated = await db
          .update(postContentVariants)
          .set({ body: next })
          .where(eq(postContentVariants.id, row.id))
          .returning({ id: postContentVariants.id });
        written += updated.length;
        matched += updated.length;
      }
    }
  }

  const result: HandleQualificationResult = {
    scanned,
    changed,
    matched,
    written,
    // A run that changed rows but wrote none is the failure this catches.
    noOpWrites: !DRY_RUN && changed > 0 && written === 0,
    samples,
  };

  logger.info('[Backfill] handle qualification complete', {
    dryRun: DRY_RUN,
    ...result,
    cappedAt: scanned >= MAX ? MAX : undefined,
  });
  return result;
}

async function main(): Promise<void> {
  const dryRun = (process.env.BACKFILL_DRY_RUN ?? 'true') !== 'false';
  const max = Number(process.env.BACKFILL_MAX ?? 5000);

  // The shared guard, not a local one: a mutating run is refused in EVERY
  // environment until the operator names this script back, because a production
  // URI can be paired with any NODE_ENV label. Dry runs need no token.
  assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun });
  await connectPostgres();
  logger.info('[Backfill] handle qualification starting', { dryRun, max });
  try {
    await backfillFederatedHandleQualification({ dryRun, max });
  } finally {
    await closePostgres();
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('[Backfill] handle qualification failed', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      process.exit(1);
    });
}
