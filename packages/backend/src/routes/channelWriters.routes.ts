/**
 * A CHANNEL'S WRITERS — the people it has already named on its posts.
 *
 * A channel is an Oxy ACCOUNT, not a Mention row (the Mention-local channel was
 * retired in migration `0026`), so `:oxyUserId` below is that account's Oxy user
 * id — the same id `/c/<handle>` resolves to and the same one every other
 * account-scoped surface takes. This router is not a revival of the local channel
 * model; it is one derived list about one kind of account.
 *
 * ── THE LIST IS WHO HAS WRITTEN, NEVER WHO MAY WRITE ──────────────────────────
 *
 * It is derived from the distinct `writtenByOxyUserId` values on the channel's
 * PUBLIC, PUBLISHED posts, and never from the account's member list. Those are
 * two different facts and only one of them is disclosable:
 *
 *  - `channel.signPosts` consents to naming the writer OF A PUBLISHED POST. Every
 *    name this route returns is therefore already on a post any reader can open —
 *    the list aggregates a disclosure that has happened, it does not make a new
 *    one.
 *  - The account's members are people who MAY publish as the channel. That set
 *    includes people who never have, people who never will, and people who never
 *    consented to being named anywhere. `listAccountMembers` would answer the
 *    wrong question, so it is deliberately not called here.
 *
 * "Just list the members, it is simpler" is the change a later reader will reach
 * for. It is simpler, and it publishes the identities of people who have written
 * nothing.
 *
 * ── THE GATE ──────────────────────────────────────────────────────────────────
 *
 * Three conditions, ALL fail-closed, and the same three that decide whether a
 * post's byline names its writer:
 *
 *  1. the account resolves through Oxy as `kind: 'channel'`,
 *  2. `UserSettings.channel.signPosts === true`, and
 *  3. this reader may see the channel's profile at all.
 *
 * (1) and (2) are `disclosesWriters` from `services/channelWriterDisclosure`,
 * which `PostHydrationService` reads too — one authority, so the list and the
 * byline cannot disagree about a consent decision. An unresolvable account, a
 * missing settings row, an unset flag and a failed lookup are all "no".
 *
 * (3) exists because a private / followers-only profile serves an EMPTY author
 * feed to a non-follower (`canViewAuthorFeed` in the feed engine). Without the
 * same check, this route would be a side door onto who writes for a channel whose
 * posts the reader cannot read. A channel has no login of its own and its only
 * settings write accepts `channel.signPosts`, so its visibility is public in
 * practice today — read rather than assumed, for the same reason `ChannelScreen`
 * reads it: hardcoding "public" would silently expose a channel somebody had
 * restricted through another surface.
 *
 * ── ONE SHAPE FOR "THERE IS NO LIST HERE" ─────────────────────────────────────
 *
 * Every refusal is a 404 with the same body: not a channel, a channel that does
 * not sign, and a channel this reader may not see are indistinguishable from each
 * other and from an id that names nothing. That is the idiom the fediverse-sharing
 * consent gate already uses (its AP surfaces 404 when sharing is off), and it
 * means no future change to what is disclosed has to revisit a status code. A
 * disclosing channel that has published nothing with a writer is a 200 with an
 * empty list — the list exists and is empty, which is a different fact.
 */

import { Router, type Response } from 'express';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { PostVisibility, type ChannelWriter, type ChannelWritersResponse } from '@mention/shared-types';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { userSettings } from '../db/schema/userProfile';
import { resolveUserSummaries } from '../services/PostHydrationService';
import { degradedActorSummary } from '../utils/degradedActorSummary';
import type { CachedUserSummary } from '../services/userSummaryCache';
import { disclosesWriters, loadSigningChannelIds } from '../services/channelWriterDisclosure';
import { checkFollowAccess, requiresAccessCheck } from '../utils/privacyHelpers';
import { createUserScopedOxyServices } from '../utils/oxyHelpers';
import { channelWritersRateLimiter } from '../middleware/security';
import { config } from '../config';
import { sendErrorResponse, sendSuccessResponse } from '../utils/apiHelpers';
import { queryInt, queryString } from '../utils/queryParams';
import { logger } from '../utils/logger';

const router = Router();

/** Longest account id we will look up — an Oxy user id is a 24-char hex ObjectId. */
const MAX_OXY_USER_ID_LENGTH = 64;

const DEFAULT_WRITERS_PAGE_SIZE = 50;
const MAX_WRITERS_PAGE_SIZE = 100;

/** The one body every refusal answers with. See the header note. */
const NO_LIST_MESSAGE = 'No writers list for that account';

/**
 * The keyset a writers page resumes from.
 *
 * `lastPostAt` alone is NOT unique — two writers whose most recent post landed in
 * the same millisecond would straddle a page boundary and be skipped or repeated
 * — so the cursor carries the writer's id as the tie-break, matching the
 * `{ lastPostAt: -1, _id: -1 }` sort exactly.
 */
interface WritersCursor {
  lastPostAt: Date;
  writerOxyUserId: string;
}

/** `<epochMillis>_<oxyUserId>` — opaque to the client, cheap to parse here. */
function encodeWritersCursor(lastPostAt: Date, writerOxyUserId: string): string {
  return `${lastPostAt.getTime()}_${writerOxyUserId}`;
}

/**
 * Parse a client-supplied cursor. A malformed token yields `undefined` (⇒ the
 * first page) rather than an error, matching `GET /subscriptions`: a tampered
 * cursor must never become a 500. The id half is only ever compared as a STRING
 * against the group key, so it needs no cast — but it is length-bounded so a
 * megabyte of cursor cannot ride into a query.
 */
function parseWritersCursor(raw: string | undefined): WritersCursor | undefined {
  if (!raw) return undefined;
  const separator = raw.indexOf('_');
  if (separator <= 0) return undefined;

  const millis = Number.parseInt(raw.slice(0, separator), 10);
  if (!Number.isFinite(millis)) return undefined;
  const lastPostAt = new Date(millis);
  if (Number.isNaN(lastPostAt.getTime())) return undefined;

  const writerOxyUserId = raw.slice(separator + 1);
  if (!writerOxyUserId || writerOxyUserId.length > MAX_OXY_USER_ID_LENGTH) return undefined;

  return { lastPostAt, writerOxyUserId };
}

/**
 * The distinct writers of a channel's posts, most recent publication first.
 *
 * WHAT COUNTS. Exactly the posts whose byline already names their writer, minus
 * the ones no visitor can reach:
 *
 *  - `oxyUserId: <channel>` — the channel is the post's OWNER. The denormalized
 *    field is synced from the owner authorship entry by the `Post` pre-save hook,
 *    so this is the owner comparison, and it is the right one rather than merely
 *    the indexed one: a post the channel merely COLLABORATED on belongs to
 *    somebody else, and its `writtenByOxyUserId` is that other owner's business.
 *  - `visibility: 'public'` + `status: 'published'` — a draft, a scheduled post,
 *    a followers-only post and a post `restricted` by moderation all drop out.
 *    This is what keeps the list one stable answer for every reader, and it is
 *    the fail-closed direction: a non-public post still names its writer to
 *    whoever may read THAT post, but it does not put a name in a directory.
 *  - `written_by_oxy_user_id is not null` — a post published by a person signed
 *    in as themselves has no writer to disclose. Mongo needed `$type: 'string'`
 *    here rather than `$exists`, because a stored `null` satisfies `$exists`
 *    while satisfying nothing else and only the typed form made the partial index
 *    eligible. Postgres has one spelling of absent, so the distinction disappears
 *    with the store that created it.
 *
 * There is deliberately no post-TYPE filter and no lane filter, so a boost the
 * channel published counts its publisher, a thread continuation counts its
 * writer, and a post tucked into a `hidden` lane counts too. None of that is an
 * oversight. Hydration names the writer on EVERY one of those posts, and a lane
 * is curation rather than privacy — those posts still reach every feed and stay
 * readable at their own URL. A list that quietly disagreed with the bylines
 * beside it ("why is X not in the writers list, their name is right there") is
 * worse than one exactly as wide as the disclosure it reports on. This is a
 * directory OF that disclosure, not a second editorial judgment about what counts
 * as writing.
 *
 * ORDER: most recent post first. The alternative, most posts first, ranks people
 * against each other — it turns a masthead into a leaderboard on a measure the
 * channel never chose, and volume is a poor proxy for contribution (one long
 * investigation against fifty short notes). Recency says something the page
 * already says everywhere else: this channel's own feed is chronological, so a
 * reader arriving from a post they just read finds its writer at the top. It also
 * pages honestly — a keyset on `(lastPostAt, writerId)` is stable, while a count
 * ordering drifts under the reader between pages.
 *
 * COST: one `GROUP BY`, served by `post_channel_writer_v1` — the channel's signed
 * posts are a contiguous, tiny slice of that partial index, and both values the
 * grouping reads live in the index, so no post row is fetched. The `ORDER BY`
 * that follows runs over DISTINCT WRITERS, a number bounded by how many humans
 * have ever published as this channel.
 *
 * THE KEYSET IS IN A `HAVING`, not a `WHERE`, and that is not interchangeable.
 * The cursor compares against `max(created_at)` — an AGGREGATE of the group, not
 * a column of any one row — so a `WHERE` would drop individual POSTS older than
 * the cursor before grouping and then report each writer's most recent SURVIVING
 * post as their `lastPostAt`. A writer would reappear on page after page with a
 * receding timestamp, and the page that was supposed to end would never end.
 */
async function loadWriterIds(
  channelOxyUserId: string,
  limit: number,
  cursor: WritersCursor | undefined,
): Promise<Array<{ writerOxyUserId: string; lastPostAt: Date }>> {
  // `.mapWith(posts.createdAt)` is what makes this a `Date` — it is NOT
  // decoration. `drizzle-orm/postgres-js` installs a TRANSPARENT parser for
  // every timestamp/date OID (`1184`, `1114`, `1082`, …) so that drizzle, not
  // postgres.js, owns the conversion; drizzle then applies it per DECLARED
  // COLUMN. A raw `sql` expression has no column behind it, so it comes back as
  // the driver's string — `'2026-01-01 00:00:00+00'` — and a bare `sql<Date>`
  // would be an assertion the compiler accepts and the runtime contradicts, one
  // `.toISOString()` later, as a 500 on every page that has a writer.
  //
  // Borrowing the COLUMN's own decoder rather than naming a converter here is
  // deliberate: the type is then DERIVED from what actually runs, so the
  // annotation cannot drift from the decoding, and a change to how `created_at`
  // is represented reaches this expression for free.
  const lastPostAt = sql`max(${posts.createdAt})`.mapWith(posts.createdAt);
  const grouped = getDb()
    .select({ writerOxyUserId: posts.writtenByOxyUserId, lastPostAt })
    .from(posts)
    .where(
      and(
        eq(posts.oxyUserId, channelOxyUserId),
        eq(posts.visibility, PostVisibility.PUBLIC),
        eq(posts.status, 'published'),
        isNotNull(posts.writtenByOxyUserId),
      ),
    )
    .groupBy(posts.writtenByOxyUserId);

  // `.having()` is applied CONDITIONALLY rather than handed `undefined`: drizzle
  // renders the clause it is given, and an absent cursor must produce a query
  // with no HAVING at all — not one with an empty predicate.
  //
  // The cursor instant is encoded with the COLUMN's own serializer for the same
  // reason the aggregate above is decoded with it: the driver setup disables
  // postgres.js's timestamp codecs in BOTH directions, so a bare `Date`
  // interpolated here is handed to the socket writer unconverted and the whole
  // query dies with `ERR_INVALID_ARG_TYPE` — a paging failure that never reaches
  // the first page, which is why only the SECOND page of a keyset test can see
  // it. Postgres resolves the parameter's type from the timestamptz on the other
  // side of the row comparison.
  const paged = cursor
    ? grouped.having(
        sql`(${lastPostAt}, ${posts.writtenByOxyUserId}) < (${posts.createdAt.mapToDriverValue(cursor.lastPostAt)}, ${cursor.writerOxyUserId})`,
      )
    : grouped;

  const rows = await paged
    .orderBy(desc(lastPostAt), desc(posts.writtenByOxyUserId))
    .limit(limit);

  // `isNotNull` narrows the ROWS, never the column's TypeScript type, so the
  // filter is what makes the non-null claim real rather than asserted.
  return rows.flatMap((row) =>
    row.writerOxyUserId === null
      ? []
      : [{ writerOxyUserId: row.writerOxyUserId, lastPostAt: row.lastPostAt }],
  );
}

/**
 * GET /channels/:oxyUserId/writers?limit=&cursor=
 *
 * Mounted with `optionalAuth`: a channel's page is public, so its writers list is
 * readable anonymously — the reader's identity matters only to condition (3) of
 * the gate above.
 */
router.get(
  '/:oxyUserId/writers',
  // Production-gated in the PER-ROUTE position. `router.use(...limiters)` with an
  // empty array throws `argument handler is required` at import outside
  // production, and this is also the only position CodeQL inspects.
  ...(config.runtime.isProduction ? [channelWritersRateLimiter] : []),
  async (req: AuthRequest, res: Response) => {
    const channelOxyUserId = typeof req.params.oxyUserId === 'string' ? req.params.oxyUserId.trim() : '';
    try {
      if (!channelOxyUserId || channelOxyUserId.length > MAX_OXY_USER_ID_LENGTH) {
        return sendErrorResponse(res, 400, 'Bad Request', 'oxyUserId is required');
      }

      const limit = Math.min(
        Math.max(queryInt(req.query.limit) || DEFAULT_WRITERS_PAGE_SIZE, 1),
        MAX_WRITERS_PAGE_SIZE,
      );
      const cursor = parseWritersCursor(queryString(req.query.cursor));

      // The identity and both settings reads, in one round trip. Nothing here
      // depends on another's answer, and the account resolve is the same batched
      // path a post author goes through — so a channel whose page was just
      // rendered is already in the identity cache.
      const [summaries, signingChannelIds, visibilityRows] = await Promise.all([
        resolveUserSummaries([channelOxyUserId]),
        loadSigningChannelIds([channelOxyUserId]),
        // ONE column, not the row: `select()` with no projection returns every
        // column, and `user_settings` is the widest table in the schema.
        getDb()
          .select({ profileVisibility: userSettings.privacyProfileVisibility })
          .from(userSettings)
          .where(eq(userSettings.oxyUserId, channelOxyUserId))
          .limit(1),
      ]);

      const account = summaries.get(channelOxyUserId)?.user;
      if (!disclosesWriters(channelOxyUserId, account, signingChannelIds)) {
        return sendErrorResponse(res, 404, 'Not Found', NO_LIST_MESSAGE);
      }

      // Only a restricted profile costs the follow check, which is an Oxy round
      // trip. The caller's OWN client is used, the same one the profile-design
      // gate uses, so the answer is scoped to who is asking.
      if (requiresAccessCheck(visibilityRows[0]?.profileVisibility ?? undefined)) {
        const viewerId = req.user?.id;
        // An anonymous reader can never satisfy a restricted profile, so the
        // upstream call is not even made for one.
        const canView = viewerId
          ? await checkFollowAccess(viewerId, channelOxyUserId, createUserScopedOxyServices(req))
          : false;
        if (!canView) {
          return sendErrorResponse(res, 404, 'Not Found', NO_LIST_MESSAGE);
        }
      }

      // One extra row decides `nextCursor` without a second query.
      const rows = await loadWriterIds(channelOxyUserId, limit + 1, cursor);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;

      // One batched identity pass for the whole page, through the same resolver
      // post authors go through. A whole-batch failure is not fatal: every writer
      // falls back to its degraded summary (empty username, `'Unknown user'`) so
      // the list still renders and self-heals on the next fetch — a raw
      // `oxyUserId` must never surface as a handle.
      let writerSummaries = new Map<string, CachedUserSummary>();
      if (page.length > 0) {
        try {
          writerSummaries = await resolveUserSummaries(page.map((row) => row.writerOxyUserId));
        } catch (error) {
          logger.warn('[ChannelWriters] Failed to resolve channel writers', {
            channelOxyUserId,
            count: page.length,
            reason: error instanceof Error ? error.message : 'unknown',
          });
        }
      }

      const writers: ChannelWriter[] = page.map((row) => ({
        writer: writerSummaries.get(row.writerOxyUserId)?.user ?? degradedActorSummary(row.writerOxyUserId),
        lastPostAt: row.lastPostAt.toISOString(),
      }));

      const last = page[page.length - 1];
      const body: ChannelWritersResponse = { writers };
      if (hasMore && last) {
        body.nextCursor = encodeWritersCursor(last.lastPostAt, last.writerOxyUserId);
      }

      return sendSuccessResponse(res, 200, body);
    } catch (error) {
      logger.error('[ChannelWriters] Error listing channel writers:', {
        channelOxyUserId,
        userId: req.user?.id,
        error,
      });
      return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to list channel writers');
    }
  },
);

export default router;
