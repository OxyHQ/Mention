/**
 * One-shot remediation: backfill the missing Oxy author link on LEGACY federated
 * "orphan" posts.
 *
 * BACKGROUND
 * ----------
 * A federated post is authored by a federated actor whose identity is bridged to
 * an Oxy user (`oxyUserId`, denormalized onto the post + its `authorship[]`). The
 * CURRENT ingest paths (`ensureFederatedNote`, `handleCreate`, `syncOutboxPosts`)
 * REQUIRE a resolved author and SKIP otherwise, so no NEW orphans are created.
 * But a cohort of LEGACY posts (ingested before that invariant) carry
 * `oxyUserId: null` — they are invisible in author feeds and render blank when a
 * boost/quote references them. Phase 1 made hydration render such posts in a
 * DEGRADED form (federation-derived author, so nothing is blank); THIS script is
 * the remediation that restores their REAL author link.
 *
 * PER-ORPHAN ALGORITHM
 * --------------------
 * For each post with `federation.activityId` set and `oxyUserId == null`:
 *   1. Determine the author actor URI, cheapest source first:
 *        - use `federation.actorUri` when present (no network); else
 *        - DERIVE the bridged actor URI from the atproto DID embedded in a Bridgy
 *          Fed object URL (`deriveBridgyActorUri`, no network) — the same
 *          derivation hydration applies to these very posts; else
 *        - re-fetch the AP object by `federation.activityId` (falling back to
 *          `federation.url`) and read `attributedTo`. brid.gy / Bluesky-bridged
 *          notes arrive over ActivityPub (brid.gy is an AP bridge) and their actor
 *          is a normal AP actor — so the SAME `actorService` path resolves them;
 *          the atproto connector is NOT involved (that is READ/discovery of NATIVE
 *          bsky, and our own outbound be-discovered bridge — both unrelated to
 *          inbound bridged content).
 *
 *      Why the middle step earns its place, measured against production on
 *      2026-08-15 over the whole 578-post orphan cohort: NONE carries a stored
 *      `actorUri`, but 509 are Bridgy Fed objects whose DID yields an actor URI
 *      locally, and 257 of those already resolve against a `federated_actors` row
 *      we hold — repaired with ZERO network calls. The remaining 252 need one
 *      ACTOR fetch per distinct DID (170 of them), not one OBJECT fetch per post.
 *      Only 69 posts have no derivable DID and reach the fetch below.
 *   2. Resolve the actor URI → `oxyUserId` via `actorService.getOrFetchActor`,
 *      forcing a full `fetchRemoteActor` (which mints/refreshes the Oxy user via
 *      the shared `resolveOxyExternalUser` identity bridge) when a cached actor
 *      row exists but was never linked. Repeated actors are resolved once
 *      (in-memory cache) — the orphans come from far fewer actors than posts:
 *      measured 2026-08-15, 578 posts over 295 distinct DIDs plus 69 non-bridged.
 *   3. On success: `replacePostAuthorship` writes the authorship rows and the
 *      denormalized `posts.oxy_user_id` they project in ONE transaction, and
 *      `federation.actorUri` is backfilled when it was missing — so a repaired
 *      post never has an owner column naming a user with no authorship row.
 *   4. DELETE the post ONLY when its source is definitively gone (HTTP 404/410)
 *      AND no author could be resolved. A transient failure (timeout, 5xx, 401/403
 *      signature rejection, SSRF-blocked, no `attributedTo`) is LEFT UNTOUCHED for
 *      a later re-run — never deleted. Note that step 1's derivation shrinks this
 *      bucket on purpose: a bridged post whose author DELETED it on Bluesky answers
 *      404/410 at the object URL while its author stays perfectly knowable, so
 *      without the derivation it would be a deletion candidate under
 *      `BACKFILL_DELETE_GONE` despite a repair being available.
 *
 * SAFETY / OPERATION
 * ------------------
 * Idempotent (a linked post leaves the `oxyUserId: null` set), batched via a
 * stable ascending `_id` cursor, bounded concurrency, best-effort per post (one
 * failure never aborts the run). Writes and deletes are OFF by default:
 *   - `BACKFILL_APPLY=true`   — actually write `oxyUserId`/`authorship`.
 *   - `BACKFILL_DELETE_GONE=true` — additionally allow deleting 404/410-gone posts.
 * With neither set the script is a pure DRY RUN that reports what it WOULD do.
 * Dry-run actor resolution is lookup-only: it never calls the identity-minting
 * actor fetch path, so a live run may link additional actors that were not
 * already present with an `oxyUserId` during the preview.
 *
 * It makes signed remote fetches (instance key pair + service token), so run it
 * as a Fargate one-shot in the oxy-api SG/subnets, post-deploy:
 *   BACKFILL_APPLY=true \
 *     CONFIRM_ADMIN_MUTATION=backfillFederatedPostAuthors \
 *     bun dist/src/scripts/backfillFederatedPostAuthors.js
 */

import { and, asc, count, eq, gt, isNotNull, isNull, type SQL } from 'drizzle-orm';
import { connectPostgres, getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { deletePostRecord, findPostRecords, replacePostAuthorship } from '../db/posts/postRepository';
import type { PostRecord } from '../db/posts/postRecord';
import { findActorByUri } from '../db/federation/actorRepository';
import { actorService } from '../connectors/activitypub/actor.service';
import { extractActorUri, signedFetch, asRecord } from '../connectors/activitypub/helpers';
import { deriveBridgyActorUri } from '../connectors/activitypub/bridgy';
import { AP_CONTENT_TYPE } from '../connectors/activitypub/constants';
import { assertSafePublicUrl } from '@oxyhq/core/server';
import { buildAuthorship } from '../utils/postAuthorship';
import { logger } from '../utils/logger';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import {
  DeletionPreflightError,
  assertPostsSafeToDelete,
} from './lib/adminDeletionPreflight';
import {
  assertAdminRunComplete,
  closeAdminScriptResources,
} from './lib/adminScriptLifecycle';

/** Orphans scanned per page (stable ascending `_id` cursor). */
const PAGE_SIZE = 200;

/** Orphans resolved in parallel within a page (bounded to be polite to remotes). */
const CONCURRENCY = 4;

/** Write `oxyUserId`/`authorship` (else dry-run: report only). */
const APPLY = process.env.BACKFILL_APPLY === 'true';

/** Additionally allow deleting posts whose source is definitively gone (404/410). */
const DELETE_GONE = process.env.BACKFILL_DELETE_GONE === 'true';

type OrphanRow = PostRecord;

/** The outcome of resolving one orphan's author actor URI. */
type AuthorUriResult =
  | { kind: 'ok'; authorUri: string; actorUriWasMissing: boolean }
  | { kind: 'gone' }
  | { kind: 'transient' };

/** mode + actorUri → resolved oxyUserId (or null) — dedupes shared actors across the whole run. */
const actorOxyCache = new Map<string, string | null>();

/**
 * actorUri → in-flight resolution promise. The bulk of the 11,967 orphans come
 * from far fewer actors, so within a page-chunk MANY concurrent orphans share one
 * actor. `actorOxyCache` only dedupes AFTER a resolve settles, so without this two
 * concurrent orphans of the same actor both hit `/users/resolve` and RACE on
 * federated-user creation (observed as HTTP 409s in the dry run). Memoizing the
 * in-flight PROMISE collapses concurrent callers for one actor onto a SINGLE
 * resolve; the settled value then lands in `actorOxyCache` for the rest of the run.
 */
const inFlightActorResolves = new Map<string, Promise<string | null>>();

/**
 * Resolve an actor URI to its Oxy user id, minting/linking the federated Oxy user
 * when necessary. `getOrFetchActor` returns a cached row as-is (kicking only a
 * background refresh), so when that row has no `oxyUserId` we force an AWAITED
 * `fetchRemoteActor`, which runs the shared identity bridge and stamps the id.
 *
 * Concurrency-safe: a settled result is served from `actorOxyCache`; a concurrent
 * call for an actor already resolving awaits the SAME in-flight promise (no
 * duplicate `/users/resolve`, no 409 race).
 */
export async function resolveAuthorOxyUserId(
  actorUri: string,
  allowIdentityMutation = true,
): Promise<string | null> {
  const cacheKey = `${allowIdentityMutation ? 'resolve' : 'lookup'}:${actorUri}`;
  const cached = actorOxyCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const inFlight = inFlightActorResolves.get(cacheKey);
  if (inFlight) return inFlight;

  const resolution = (async (): Promise<string | null> => {
    let oxyUserId: string | null = null;
    try {
      if (!allowIdentityMutation) {
        const actor = await findActorByUri(actorUri);
        oxyUserId = actor?.oxyUserId ?? null;
      } else {
        const actor = await actorService.getOrFetchActor(actorUri);
        oxyUserId = actor?.oxyUserId ?? null;
        if (!oxyUserId) {
          const refreshed = await actorService.fetchRemoteActor(actorUri);
          oxyUserId = refreshed?.oxyUserId ?? null;
        }
      }
    } catch (error) {
      logger.warn('[backfillFederatedPostAuthors] actor resolution failed', {
        actorUri,
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
    actorOxyCache.set(cacheKey, oxyUserId);
    return oxyUserId;
  })();

  inFlightActorResolves.set(cacheKey, resolution);
  try {
    return await resolution;
  } finally {
    inFlightActorResolves.delete(cacheKey);
  }
}

/**
 * Determine the author actor URI for an orphan, cheapest source first: the stored
 * `federation.actorUri`, then the actor URI DERIVED from a Bridgy Fed object URL,
 * and only then a re-fetch of the AP object to read `attributedTo`.
 * Distinguishes a definitively-gone source (404/410) from a transient failure so
 * only truly-dead posts become deletion candidates.
 */
export async function resolveOrphanAuthorUri(orphan: OrphanRow): Promise<AuthorUriResult> {
  const storedActorUri = orphan.federation?.actorUri;
  if (storedActorUri) {
    return { kind: 'ok', authorUri: storedActorUri, actorUriWasMissing: false };
  }

  // A Bridgy Fed object URL embeds the author's atproto DID
  // (`.../convert/ap/at://<did>/app.bsky.feed.post/<rkey>`), and an AT-URI's
  // authority IS the repo holding the record — the author, by protocol
  // definition rather than by pattern guess. The bridged actor URI is a pure
  // function of that DID, so the author is knowable with NO network round trip.
  // This is the SAME derivation hydration already applies to these very posts
  // (`resolveOrphanFederatedAuthors`); both call one helper on purpose.
  //
  // It is not only cheaper, it is STRICTLY MORE CORRECT than the fetch below.
  // The object URL 404s once the author deletes the post on Bluesky, which sends
  // the orphan to the `gone` bucket — so without this branch, a post whose author
  // was locally knowable all along becomes a deletion candidate under
  // `BACKFILL_DELETE_GONE`. An actor also outlives any single post, so the
  // derived URI resolves in cases where the object fetch cannot.
  const derivedActorUri = deriveBridgyActorUri(
    orphan.federation?.activityId,
    orphan.federation?.url,
  );
  if (derivedActorUri) {
    return { kind: 'ok', authorUri: derivedActorUri, actorUriWasMissing: true };
  }

  const objectUrl = orphan.federation?.activityId || orphan.federation?.url;
  if (!objectUrl) return { kind: 'transient' };

  const guard = await assertSafePublicUrl(objectUrl);
  if (!guard.ok) return { kind: 'transient' };

  let res: Response;
  try {
    res = await signedFetch(objectUrl, AP_CONTENT_TYPE);
  } catch {
    return { kind: 'transient' };
  }

  if (res.status === 404 || res.status === 410) return { kind: 'gone' };
  if (!res.ok) return { kind: 'transient' };

  let note: Record<string, unknown> | null;
  try {
    note = asRecord(await res.json());
  } catch {
    return { kind: 'transient' };
  }

  const authorUri = extractActorUri(note?.attributedTo);
  if (!authorUri) return { kind: 'transient' };
  return { kind: 'ok', authorUri, actorUriWasMissing: true };
}

interface Counters {
  scanned: number;
  linked: number;
  gone: number;
  deleteCandidates: number;
  deleted: number;
  blockedDelete: number;
  unresolvedAuthor: number;
  transient: number;
}

/** Process one orphan; returns the counter bucket it fell into. */
async function processOrphan(orphan: OrphanRow): Promise<keyof Omit<Counters, 'scanned'>> {
  const uriResult = await resolveOrphanAuthorUri(orphan);

  if (uriResult.kind === 'transient') return 'transient';

  if (uriResult.kind === 'gone') {
    // Only delete when the source is gone AND no author is resolvable. There is no
    // actor URI to resolve here (a gone object yields none), so the post is dead.
    if (!DELETE_GONE) return 'gone';
    if (!APPLY) return 'deleteCandidates';
    await assertPostsSafeToDelete(
      `backfillFederatedPostAuthors:${orphan.id}`,
      [{
        id: orphan.id,
        uris: [
          orphan.federation?.activityId,
          orphan.federation?.url,
        ].filter((value): value is string => typeof value === 'string' && value.length > 0),
      }],
    );
    await deletePostRecord(orphan.id, undefined);
    return 'deleted';
  }

  // A dry run is lookup-only: actorService's fetch path can mint an Oxy identity
  // and upsert FederatedActor, so it is reserved for the explicitly-applied run.
  const oxyUserId = await resolveAuthorOxyUserId(uriResult.authorUri, APPLY);
  if (!oxyUserId) return 'unresolvedAuthor';

  if (APPLY) {
    // `replacePostAuthorship` writes BOTH the authorship rows and the
    // denormalized `posts.oxy_user_id` they project, in one transaction — the
    // pre-save hook's job, now explicit. Writing `oxyUserId` alone would leave a
    // post whose owner column names a user with no authorship row, which every
    // author-feed query matches on.
    await replacePostAuthorship(orphan.id, buildAuthorship(oxyUserId, []));
    // Backfill the actor URI when it was missing (brid.gy/Bluesky orphans) so the
    // Phase-1 degraded-render path can also enrich by URI next time.
    if (uriResult.actorUriWasMissing) {
      await getDb()
        .update(posts)
        .set({ federationActorUri: uriResult.authorUri })
        .where(eq(posts.id, orphan.id));
    }
  }
  return 'linked';
}

async function backfillFederatedPostAuthors(): Promise<void> {
  const startedAt = Date.now();

  // `is not null` / `is null`, never `<> null`: Mongo's `$ne: null` also matched
  // an ABSENT field, while SQL's `<>` against NULL matches nothing — so the
  // literal translation would find zero orphans and report a clean run.
  const orphanFilter = and(
    isNotNull(posts.federationActivityId),
    isNull(posts.oxyUserId),
  ) as SQL;

  try {
    assertAdminMutationAllowed({
      scriptName: 'backfillFederatedPostAuthors',
      dryRun: !APPLY,
    });
    await connectPostgres();
    logger.info('[backfillFederatedPostAuthors] connected to PostgreSQL', {
      apply: APPLY,
      deleteGone: DELETE_GONE,
    });

    const [totals] = await getDb()
      .select({ count: count() })
      .from(posts)
      .where(orphanFilter);
    const totalCount = totals?.count ?? 0;
    logger.info(`[backfillFederatedPostAuthors] ${totalCount} orphan federated posts to scan`);
    if (totalCount === 0) {
      return;
    }

    const counters: Counters = {
      scanned: 0,
      linked: 0,
      gone: 0,
      deleteCandidates: 0,
      deleted: 0,
      blockedDelete: 0,
      unresolvedAuthor: 0,
      transient: 0,
    };
    let lastId: string | null = null;

    for (;;) {
      const page = await findPostRecords(
        lastId ? and(orphanFilter, gt(posts.id, lastId)) : orphanFilter,
        { orderBy: [asc(posts.id)], limit: PAGE_SIZE },
      );

      if (page.length === 0) break;

      // Bounded-concurrency fan-out over the page. `lastId` advances past the whole
      // page, and mutating/deleting an already-scanned _id never affects the
      // forward cursor, so linked posts simply leave the set.
      for (let i = 0; i < page.length; i += CONCURRENCY) {
        const chunk = page.slice(i, i + CONCURRENCY);
        const buckets = await Promise.all(
          chunk.map((orphan) =>
            processOrphan(orphan).catch((error) => {
              logger.warn('[backfillFederatedPostAuthors] orphan processing failed', {
                postId: orphan.id,
                reason: error instanceof Error ? error.message : 'unknown',
              });
              return error instanceof DeletionPreflightError
                ? 'blockedDelete' as const
                : 'transient' as const;
            }),
          ),
        );
        for (const bucket of buckets) counters[bucket] += 1;
      }

      counters.scanned += page.length;
      lastId = page[page.length - 1].id;
      logger.info(
        `[backfillFederatedPostAuthors] progress: scanned ${counters.scanned}/${totalCount}, ` +
          `linked ${counters.linked}, gone ${counters.gone}, ` +
          `deleteCandidates ${counters.deleteCandidates}, deleted ${counters.deleted}, ` +
          `blockedDelete ${counters.blockedDelete}, unresolvedAuthor ${counters.unresolvedAuthor}, ` +
          `transient ${counters.transient}`,
      );
    }

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[backfillFederatedPostAuthors] done in ${elapsedSeconds}s: scanned ${counters.scanned}, ` +
        `linked ${counters.linked}, gone ${counters.gone}, ` +
        `deleteCandidates ${counters.deleteCandidates}, deleted ${counters.deleted}, ` +
        `blockedDelete ${counters.blockedDelete}, unresolvedAuthor ${counters.unresolvedAuthor}, ` +
        `transient ${counters.transient}` +
        (APPLY ? '' : ' (DRY RUN — no writes)'),
    );

    assertAdminRunComplete('backfillFederatedPostAuthors', {
      goneNotDeleted: APPLY && !DELETE_GONE ? counters.gone : 0,
      blockedDelete: counters.blockedDelete,
      unresolvedAuthor: counters.unresolvedAuthor,
      transient: counters.transient,
    });
  } catch (error) {
    logger.error('[backfillFederatedPostAuthors] failed', error);
    throw error;
  } finally {
    await closeAdminScriptResources();
  }
}

if (require.main === module) {
  // Exit deterministically: imported singletons (BullMQ Redis, MediaCache workers)
  // otherwise keep the event loop alive after the work completes.
  backfillFederatedPostAuthors()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('[backfillFederatedPostAuthors] unhandled failure', error);
      process.exit(1);
    });
}

export default backfillFederatedPostAuthors;
