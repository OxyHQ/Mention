/**
 * Recurring retention for what federation copies into the shared database: old
 * federated posts nobody here engaged with or depends on, and the backlog of
 * mirrored follow edges whose other end never became an account here.
 *
 * DRAFT FOR THE OWNER. Deleting production data is the app owner's decision;
 * nothing schedules this job. See the pull request that added it for the
 * measurements and the expected savings.
 *
 * WHY
 *   `oxy-postgres` is shared by every Oxy app. Measured 2026-11-27/28: `mention`
 *   is 85.7 GiB, the federated post family about 63 GiB of it (`posts` 28.4 GiB,
 *   13.1M rows, ~98% federated, 36% older than 90 days because outbox backfills
 *   import old history), and `remote_follow_edges` 10.0 GiB in ~23 days. Nothing
 *   ever removes an old federated post (`db/expiry.ts` has no `posts` entry).
 *
 * PHASE `posts` — a federated post is DELETED only when ALL of these hold:
 *   - it is external (`federation_actor_uri` or `federation_activity_id` set,
 *     the `posts_external_kind_idx` predicate), public and published (anything
 *     followers-only, direct, restricted or incomplete is kept);
 *   - it is older than `RETENTION_POST_MAX_AGE_DAYS` (default 90, minimum 30 —
 *     the longest ranking window, interest/affinity, is 30 days);
 *   - nothing on {@link POST_KEEP_REASONS} holds for it. In words: no local
 *     owner or co-author, not pinned or curated, no bookmark, no like by a local
 *     account, no mention of a local account, no post (of anyone) reposting,
 *     quoting, replying to or threading under it, it does not itself point at a
 *     local post, no local post in its thread, no notification about it, no
 *     report / label / enforcement about it, no poll, attendance, article,
 *     promotion, commerce metrics, gate, correction or cross-post cluster, no
 *     feed interaction, no pending engagement delivery, not in a local
 *     community, and not among the newest {@link DEFAULT_KEEP_NEWEST_PER_FOLLOWED_AUTHOR}
 *     public posts of an author a local user follows.
 *
 *   The last rule stops a delete/re-import loop: the followed-outbox sync (every
 *   15 min) and a profile view re-read an author's newest 20 items at any age
 *   and store whatever is missing, so those must stay. Posts referenced by other
 *   posts are kept while the referrer exists, so a thread or boost chain is
 *   removed from its leaves inward across passes, never with a dangling parent.
 *
 *   "Local account" is decided by Oxy, not by this database: an account with no
 *   `federated_actors` row is local; one with a row is asked of Oxy
 *   (`type === 'federated'` or `isFederated`) because a Move or an identity
 *   projection points an actor row at a LOCAL person. An account Oxy does not
 *   answer for (missing or failed) counts as local, so the post is kept.
 *
 *   After `assertPostsSafeToDelete` cleared the batch with nothing acknowledged
 *   but the rows `ON DELETE CASCADE` removes and that the rules above decided
 *   may go (remote likes, the recent-replier projection, evaluations), the
 *   delete locks the batch's rows and then runs one `DELETE ... WHERE id IN
 *   (batch) AND <the SQL rules again>` in the same transaction, so a save, like
 *   or reply committed meanwhile is seen and one still open has to wait. The
 *   post family (variants, authorships, media, source keys, hashtags, import
 *   ledger, mentions, attachments, …) goes by its foreign keys. Counters on a
 *   surviving parent are not adjusted: the remote reply still exists, only our
 *   cached copy is gone (the same call `purgeBlockedDomainContent` makes).
 *
 *   The re-hosted federated media of a deleted post is queued for deletion in
 *   the same transaction, as any post deletion does; the drain keeps a file
 *   something else still uses.
 *
 * PHASE `follow-edges` — drains the unknown-end expiry of
 *   `remote_follow_edges` (`expireUnknownRemoteFollowEdges`, the same statement
 *   the 30-minute sweep runs, 100k edges a run at most) off-peak, with a TTL the
 *   owner chooses (`RETENTION_EDGE_UNKNOWN_TTL_DAYS`, default 30 = the sweep's).
 *   An edge between two known accounts is never touched. The dry run measures
 *   the share of edges with an unknown end from a 0.1% block sample.
 *
 * SPACE
 *   DELETE frees space INSIDE the tables for reuse once autovacuum has passed:
 *   the tables stop growing for as long as the freed space lasts. It does not
 *   shrink the volume; that needs `VACUUM FULL` or `pg_repack`, an owner call.
 *
 * SAFETY
 *   - `DRY_RUN` defaults to true: it reports what it would delete and writes
 *     nothing, not even its cursor. A live run requires
 *     `CONFIRM_ADMIN_MUTATION=pruneFederatedRetention`.
 *   - Small batches walked by `(created_at, id)` over a public-posts time index
 *     (`posts_public_author_recent_idx` / `post_public_chrono_v1`)
 *     (only the range past the cutoff is read; a primary-key walk would read the
 *     64% of the table inside the window on every pass), deleted by primary key.
 *   - Resumable and idempotent: the cursor is stored in `admin_script_cursors`
 *     after every batch; a finished pass is stamped and the next run starts a
 *     new pass from the oldest post (posts freed by an earlier pass's deletes,
 *     and posts that aged past the cutoff, are picked up then).
 *   - Off-peak and latency guard: every batch goes through a {@link RetentionBatchGate}.
 *     Its interface is `BackfillThrottle.beforeBatch` from `perf/backfill-io-guard`
 *     (#2058); until that lands, the CLI uses {@link createRetentionGate}: batches
 *     only inside `RETENTION_WINDOW_UTC` (default 01-07), and the run stops
 *     (exit 75, cursor kept) after three batches slower than
 *     `RETENTION_SLOW_BATCH_MS` in a row. Once #2058 merges, swap it for
 *     `createBackfillThrottle({ script, pauseMs, dryRun })`.
 *
 * ENV
 *   DRY_RUN=false                       live run (default: dry run)
 *   CONFIRM_ADMIN_MUTATION              must equal `pruneFederatedRetention` for a live run
 *   RETENTION_PHASES                    `posts,follow-edges` (default both)
 *   RETENTION_POST_MAX_AGE_DAYS         default 90 (60 is the more aggressive option)
 *   RETENTION_KEEP_NEWEST_PER_FOLLOWED_AUTHOR  default 20
 *   RETENTION_EDGE_UNKNOWN_TTL_DAYS     default 30
 *   RETENTION_BATCH_SIZE                default 500 posts / 5000 edges per statement
 *   RETENTION_LIMIT                     posts scanned this run (a canary or a dry-run sample; default 20000 on a dry run)
 *   RETENTION_START_AT                  ISO date: start a fresh walk at this created_at (sampling)
 *   RETENTION_WINDOW_UTC                off-peak window, `HH-HH` or `always` (default 01-07)
 *   RETENTION_SLOW_BATCH_MS             default 30000
 *   RESET_CURSOR=1                      forget recorded progress
 *
 * RUN AS AN ECS ONE-SHOT (dry run first):
 *   bun packages/backend/dist/src/scripts/pruneFederatedRetention.js
 *   DRY_RUN=false CONFIRM_ADMIN_MUTATION=pruneFederatedRetention \
 *     bun packages/backend/dist/src/scripts/pruneFederatedRetention.js
 */

import { sql, type SQL } from 'drizzle-orm';
import { connectPostgres, getDb } from '../db/postgres';
import { enqueueFederatedMediaDeletionsForPosts } from '../db/federation/mediaDeletionRepository';
import { expireUnknownRemoteFollowEdges } from '../db/federation/remoteGraphRepository';
import { unknownEdgeExpiryCutoff } from '../connectors/remoteGraphMirror';
import { BRIDGY_BSKY_ACTOR_PREFIX } from '../connectors/shared/bridgyActor';
import { POST_REFERENCES_REMOVED_BY_DATABASE } from '../services/posts/PostDeletionCascade';
import { lookupOxyUsers } from '../utils/oxyUserLookup';
import { logger } from '../utils/logger';
import { sleep as realSleep } from '../utils/sleep';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import {
  clearAdminScriptCursor,
  readAdminScriptCursor,
  recordAdminScriptCursor,
} from './lib/adminScriptCursor';
import {
  DeletionPreflightError,
  assertPostsSafeToDelete,
  type PostReferenceProbeName,
} from './lib/adminDeletionPreflight';

export const SCRIPT_NAME = 'pruneFederatedRetention';

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_POST_MAX_AGE_DAYS = 90;
/** The longest ranking window (interest scores, content affinity) is 30 days. */
export const MIN_POST_MAX_AGE_DAYS = 30;
/** The followed-outbox sync and a profile view re-read an author's newest 20 items. */
export const DEFAULT_KEEP_NEWEST_PER_FOLLOWED_AUTHOR = 20;
export const DEFAULT_EDGE_UNKNOWN_TTL_DAYS = 30;
export const DEFAULT_POST_BATCH_SIZE = 500;
export const DEFAULT_EDGE_BATCH_SIZE = 5_000;
/** A dry run is a sample unless the operator asks for more: reads cost IO too. */
export const DEFAULT_DRY_RUN_LIMIT = 20_000;
/** The exit code of a run the gate stopped: work is left, re-run it later. */
export const EXIT_RETENTION_STOPPED = 75;

const POSTS_SCOPE = 'posts';

/**
 * The cascaded references the preflight may stop demanding, because the rules
 * decided they may go with the post: likes (only remote ones survive the
 * rules), the recent-replier projection and the JEV evaluation rows. Every
 * other probe stays strict, including the post graph.
 */
export const RETENTION_ACKNOWLEDGED_CASCADES = [
  'likes.post_id',
  'post_recent_repliers.post_id',
  'post_evaluations.post_id',
] as const satisfies readonly PostReferenceProbeName[];

for (const name of RETENTION_ACKNOWLEDGED_CASCADES) {
  if (!POST_REFERENCES_REMOVED_BY_DATABASE.includes(name)) {
    throw new Error(`[${SCRIPT_NAME}] ${name} is no longer removed by ON DELETE CASCADE`);
  }
}

// ── The batch gate ──────────────────────────────────────────────────────────

/** Where the loop has got to (the shape `BackfillThrottle` takes, #2058). */
export interface RetentionBatchProgress {
  cursor?: string | null;
  scope?: string;
  scanned?: number;
}

/** Called at the top of every batch. Shaped like `BackfillThrottle` so #2058's guard drops in. */
export interface RetentionBatchGate {
  beforeBatch(progress?: RetentionBatchProgress): Promise<void>;
}

/** The gate stopped the run: work is left; the cursor is where the next run resumes. */
export class RetentionStoppedError extends Error {
  readonly exitCode = EXIT_RETENTION_STOPPED;
  constructor(readonly reason: 'window-closed' | 'database-slow') {
    super(`[${SCRIPT_NAME}] stopped by the batch gate: ${reason}`);
    this.name = 'RetentionStoppedError';
  }
}

/** The plain pause between batches: in-process callers and the suites. */
export function fixedPauseGate(
  pauseMs: number,
  sleep: (ms: number) => Promise<void> = realSleep,
): RetentionBatchGate {
  let started = false;
  return {
    async beforeBatch() {
      if (started && pauseMs > 0) await sleep(pauseMs);
      started = true;
    },
  };
}

/** `HH-HH` in UTC (may wrap midnight) or `always`. */
export function parseRetentionWindow(raw: string | undefined): [number, number] | 'always' {
  const value = (raw ?? '').trim().toLowerCase() || '01-07';
  if (value === 'always') return 'always';
  const match = /^(\d{1,2})-(\d{1,2})$/.exec(value);
  const start = match ? Number(match[1]) : Number.NaN;
  const end = match ? Number(match[2]) : Number.NaN;
  if (!match || start > 23 || end > 24 || start === end) {
    throw new Error(`RETENTION_WINDOW_UTC=${raw} is not a window: use HH-HH in UTC or "always"`);
  }
  return [start, end];
}

function insideWindow(window: [number, number] | 'always', nowMs: number): boolean {
  if (window === 'always') return true;
  const hour = new Date(nowMs).getUTCHours();
  const [start, end] = window;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export interface RetentionGateOptions {
  window: [number, number] | 'always';
  pauseMs: number;
  /** A batch slower than this is slow. */
  slowBatchMs: number;
  /** Stop after this many slow batches in a row. */
  maxConsecutiveSlow: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The interim guard until #2058 lands: batches only inside the off-peak window
 * (the run STOPS when it closes rather than sleeping a day inside a one-shot),
 * and a run whose batches stay slow stops instead of grinding the instance.
 */
export function createRetentionGate(opts: RetentionGateOptions): RetentionBatchGate {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  let last: number | undefined;
  let consecutiveSlow = 0;
  return {
    async beforeBatch() {
      const at = now();
      if (last !== undefined) {
        consecutiveSlow = at - last > opts.slowBatchMs ? consecutiveSlow + 1 : 0;
        if (consecutiveSlow >= opts.maxConsecutiveSlow) {
          throw new RetentionStoppedError('database-slow');
        }
      }
      if (!insideWindow(opts.window, at)) throw new RetentionStoppedError('window-closed');
      if (last !== undefined && opts.pauseMs > 0) await sleep(opts.pauseMs);
      last = now();
    },
  };
}

// ── Who is local ────────────────────────────────────────────────────────────

/** Returns the ids among `ids` that are PROVABLY remote. Anything else is treated as local. */
export type RemoteAccountClassifier = (ids: readonly string[]) => Promise<ReadonlySet<string>>;

/**
 * The default classifier: no `federated_actors` row means local; with one, Oxy
 * decides. Memoized for the run. Fails closed: an account Oxy did not answer
 * for is local, which keeps the post.
 */
export function createRemoteAccountClassifier(
  lookup: typeof lookupOxyUsers = lookupOxyUsers,
): RemoteAccountClassifier {
  const remote = new Map<string, boolean>();
  return async (ids) => {
    const unknown = [...new Set(ids)].filter((id) => id && !remote.has(id));
    if (unknown.length > 0) {
      const rows = await getDb().execute<{ oxy_user_id: string }>(sql`
        select distinct oxy_user_id from federated_actors
        where oxy_user_id = any(${textArray(unknown)})
      `);
      const withActorRow = new Set(rows.map((row) => row.oxy_user_id));
      for (const id of unknown) if (!withActorRow.has(id)) remote.set(id, false);
      const ask = unknown.filter((id) => withActorRow.has(id));
      if (ask.length > 0) {
        const answer = await lookup(ask, 'federation.retention').catch(() => null);
        const federated = new Set(
          (answer?.found ?? [])
            .filter((user) => user.type === 'federated' || user.isFederated === true)
            .map((user) => String(user.id)),
        );
        const failed = new Set((answer?.failed ?? ask).map(String));
        for (const id of ask) {
          // A failed answer is not remembered: the next batch asks again.
          if (failed.has(id) && !federated.has(id)) continue;
          remote.set(id, federated.has(id));
        }
      }
    }
    return new Set(ids.filter((id) => remote.get(id) === true));
  };
}

// ── The post rules ──────────────────────────────────────────────────────────

/**
 * Every reason a post is kept. The SQL-evaluated ones are re-checked inside the
 * DELETE itself, so a reference that appears between the read and the delete
 * still keeps the post.
 */
export const POST_KEEP_REASONS = [
  'local',
  'pinnedOrCurated',
  'bookmarked',
  'referenced',
  'referencesLocal',
  'localInThread',
  'notified',
  'moderation',
  'feature',
  'interacted',
  'pendingDelivery',
  'localAccount',
  'newestOfFollowedAuthor',
] as const;
export type PostKeepReason = (typeof POST_KEEP_REASONS)[number];

/** The SQL rules, each a boolean over the post aliased `p`. */
const SQL_RULES: Readonly<
  Record<
    Exclude<PostKeepReason, 'localAccount' | 'newestOfFollowedAuthor' | 'pendingDelivery'>,
    SQL
  >
> = {
  local: sql`(p.federation_actor_uri is null and p.federation_activity_id is null)`,
  pinnedOrCurated: sql`(p.metadata_is_pinned or coalesce(p.curated, false))`,
  bookmarked: sql`exists (select 1 from bookmarks b where b.post_id = p.id)`,
  // One EXISTS per column so each probe uses its own index.
  referenced: sql`(exists (select 1 from posts c where c.repost_of = p.id)
    or exists (select 1 from posts c where c.quote_of = p.id)
    or exists (select 1 from posts c where c.parent_post_id = p.id)
    or exists (select 1 from posts c where c.thread_id = p.id and c.id <> p.id))`,
  referencesLocal: sql`exists (select 1 from posts t
    where t.id in (p.repost_of, p.quote_of, p.parent_post_id, p.thread_id)
      and t.federation_actor_uri is null and t.federation_activity_id is null)`,
  localInThread: sql`exists (select 1 from posts l
    where l.thread_id = coalesce(p.thread_id, p.id)
      and l.federation_actor_uri is null and l.federation_activity_id is null)`,
  notified: sql`exists (select 1 from notifications n
    where n.entity_type in ('post', 'reply') and n.entity_id = p.id)`,
  moderation: sql`(exists (select 1 from reports r
      where r.reported_type in ('post', 'comment') and r.reported_id = p.id)
    or exists (select 1 from content_labels cl where cl.target_type = 'post' and cl.target_id = p.id)
    or exists (select 1 from moderation_enforcements me
      where me.subject_type in ('post', 'comment') and me.subject_id = p.id))`,
  // EVERY poll, voted or not: the preflight refuses a batch holding any.
  feature: sql`(exists (select 1 from polls pl where pl.post_id = p.id)
    or exists (select 1 from event_attendance ea where ea.post_id = p.id)
    or exists (select 1 from articles a where a.post_id = p.id)
    or exists (select 1 from commerce_post_daily_metrics cm where cm.post_id = p.id)
    or exists (select 1 from postgates pg where pg.post_id = p.id)
    or exists (select 1 from threadgates tg where tg.post_id = p.id)
    or exists (select 1 from post_corrections pc where pc.post_id = p.id)
    or exists (select 1 from post_equivalence_members em where em.post_id = p.id))`,
  interacted: sql`exists (select 1 from feed_interactions fi where fi.post_uri = p.id)`,
};

/** Any SQL rule holds. */
const ANY_SQL_RULE = sql.join(
  Object.values(SQL_RULES).map((rule) => sql`(${rule})`),
  sql` or `,
);

/**
 * A list of ids as ONE `text[]` parameter, so a batch whose posts carry
 * thousands of likers cannot reach the bind-parameter ceiling. Every id here is
 * a uuid, a 24-hex id or an actor URI, none of which holds the separator.
 */
function textArray(ids: readonly string[]): SQL {
  for (const id of ids) {
    if (id.includes(ID_SEPARATOR)) throw new Error(`[${SCRIPT_NAME}] unexpected id shape`);
  }
  return sql`string_to_array(${ids.join(ID_SEPARATOR)}, ${ID_SEPARATOR})`;
}

const ID_SEPARATOR = '\u001f';

/** What the rules know about one post of a batch. */
export interface PostRetentionFacts {
  id: string;
  type: string;
  createdAt: Date;
  oxyUserId: string | null;
  federationActorUri: string | null;
  uris: string[];
  /** Every account whose standing here could keep the post: owner, co-authors, likers, mentioned, community. */
  accounts: string[];
  sqlReasons: PostKeepReason[];
  /** Reasons read once per batch from tables with no index for a per-post probe. */
  batchReasons: PostKeepReason[];
}

/** The pure decision, given the facts and who is provably remote. */
export function decidePostRetention(
  facts: PostRetentionFacts,
  remoteAccounts: ReadonlySet<string>,
  newestOfFollowedAuthor: boolean,
): { delete: boolean; keptBy: PostKeepReason[] } {
  const keptBy = [...facts.sqlReasons, ...facts.batchReasons];
  // The accounts and the followed-author window are read only for posts no rule kept.
  if (keptBy.length > 0) return { delete: false, keptBy };
  if (facts.accounts.some((id) => !remoteAccounts.has(id))) keptBy.push('localAccount');
  if (newestOfFollowedAuthor) keptBy.push('newestOfFollowedAuthor');
  return { delete: keptBy.length === 0, keptBy };
}

type PageRow = {
  id: string;
  created_at: string | Date;
};

/** One page of the walk: public, published, older than the cutoff, after the cursor. */
async function readPage(
  cutoff: Date,
  after: { createdAt: Date; id: string } | null,
  limit: number,
): Promise<PageRow[]> {
  const cursor = after
    ? sql`and (created_at, id) > (${after.createdAt.toISOString()}::timestamptz, ${after.id})`
    : sql``;
  return getDb().execute<PageRow>(sql`
    select id, created_at from posts
    where visibility = 'public' and status = 'published'
      and created_at < ${cutoff.toISOString()}::timestamptz
      ${cursor}
    order by created_at asc, id asc
    limit ${limit}
  `);
}

/** The facts for a page's posts, in one round trip per kind. */
async function loadFacts(ids: readonly string[]): Promise<PostRetentionFacts[]> {
  if (ids.length === 0) return [];
  const flagColumns = sql.join(
    Object.entries(SQL_RULES).map(([name, rule]) => sql`(${rule}) as ${sql.identifier(name)}`),
    sql`, `,
  );
  const rows = await getDb().execute<Record<string, unknown>>(sql`
    select p.id, p.type, p.created_at, p.oxy_user_id, p.federation_actor_uri,
      p.federation_activity_id, p.federation_url, p.community_oxy_user_id,
      ${flagColumns}
    from posts p
    where p.id = any(${textArray(ids)})
  `);

  const facts = rows.map((row): PostRetentionFacts => {
    const sqlReasons = (Object.keys(SQL_RULES) as PostKeepReason[]).filter(
      (name) => row[name] === true,
    );
    const accounts = [row.oxy_user_id, row.community_oxy_user_id].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    return {
      id: String(row.id),
      type: String(row.type),
      createdAt: new Date(row.created_at as string),
      oxyUserId: (row.oxy_user_id as string | null) ?? null,
      federationActorUri: (row.federation_actor_uri as string | null) ?? null,
      uris: [row.federation_activity_id, row.federation_url].filter(
        (value): value is string => typeof value === 'string' && value.length > 0,
      ),
      accounts,
      sqlReasons,
      batchReasons: [],
    };
  });

  // The accounts and the unindexed queue are read only for posts still in play.
  const open = facts.filter((fact) => fact.sqlReasons.length === 0);
  if (open.length === 0) return facts;
  const openIds = open.map((fact) => fact.id);
  const byId = new Map(open.map((fact) => [fact.id, fact]));
  const [people, unindexed] = await Promise.all([
    getDb().execute<{ post_id: string; account: string }>(sql`
      select post_id, oxy_user_id as account from post_authorships where post_id = any(${textArray(openIds)})
      union
      select post_id, user_id from likes where post_id = any(${textArray(openIds)})
      union
      select post_id, oxy_user_id from post_mentions where post_id = any(${textArray(openIds)})
    `),
    // No usable index (`engagement_outbox.payload_post_id` has none; `post_promotions`
    // indexes only open promotions): one scan per batch, not one per post.
    getDb().execute<{ post_id: string; reason: PostKeepReason }>(sql`
      select distinct payload_post_id as post_id, 'pendingDelivery' as reason from engagement_outbox
      where payload_post_id = any(${textArray(openIds)})
      union
      select distinct post_id, 'feature' from post_promotions
      where post_id = any(${textArray(openIds)})
    `),
  ]);
  for (const row of people) byId.get(row.post_id)?.accounts.push(row.account);
  for (const row of unindexed) byId.get(row.post_id)?.batchReasons.push(row.reason);
  return facts;
}

/**
 * Which posts are among the newest `keep` public posts of an actor a local user
 * follows. Counted per source ACTOR, as the outbox sync reads them: linked
 * accounts share one Oxy owner, and one's posts must not push another's out of
 * its window. Thresholds are memoized for the run: the walk is in time order,
 * so the same actors recur batch after batch.
 */
function createFollowedAuthorWindow(keep: number) {
  const followed = new Map<string, boolean>();
  const threshold = new Map<string, { createdAt: Date; id: string } | null>();

  return async (facts: readonly PostRetentionFacts[]): Promise<Set<string>> => {
    const inWindow = new Set<string>();
    if (keep <= 0) return inWindow;
    const actors = [
      ...new Set(
        facts.flatMap((fact) => (fact.federationActorUri ? [fact.federationActorUri] : [])),
      ),
    ].filter((uri) => !followed.has(uri));
    if (actors.length > 0) {
      const rows = await getDb().execute<{ uri: string }>(sql`
        select distinct remote_actor_uri as uri from federated_follows
        where remote_actor_uri = any(${textArray(actors)})
          and direction = 'outbound' and status = 'accepted'
      `);
      const found = new Set(rows.map((row) => row.uri));
      for (const uri of actors) followed.set(uri, found.has(uri));
    }

    for (const fact of facts) {
      if (!fact.federationActorUri || !followed.get(fact.federationActorUri)) continue;
      // A followed author's post with no owner id cannot be placed in the window: keep it.
      if (!fact.oxyUserId) {
        inWindow.add(fact.id);
        continue;
      }
      const key = `${fact.oxyUserId}${ID_SEPARATOR}${fact.federationActorUri}`;
      if (!threshold.has(key)) {
        // The owner leads so the author index serves it; the actor narrows.
        const [row] = await getDb().execute<{ created_at: string | Date; id: string }>(sql`
          select created_at, id from posts
          where oxy_user_id = ${fact.oxyUserId} and visibility = 'public' and status = 'published'
            and federation_actor_uri = ${fact.federationActorUri}
          order by created_at desc, id desc
          offset ${keep - 1} limit 1
        `);
        threshold.set(key, row ? { createdAt: new Date(row.created_at), id: row.id } : null);
      }
      const nth = threshold.get(key);
      const newer =
        !nth ||
        fact.createdAt.getTime() > nth.createdAt.getTime() ||
        (fact.createdAt.getTime() === nth.createdAt.getTime() && fact.id >= nth.id);
      if (newer) inWindow.add(fact.id);
    }
    return inWindow;
  };
}

/**
 * Delete the batch, re-checking every SQL rule and that no account outside
 * `remote` liked, authored or is mentioned by it, in the statement itself.
 *
 * The rows are locked FIRST, in the same transaction. A statement checks its
 * conditions against the snapshot it started with: a bookmark, like or reply
 * committed while a bare DELETE waited on the post row would be invisible to it
 * and then cascade away. `FOR UPDATE` conflicts with the key lock a foreign-key
 * insert takes, so once the locks are held every such write has either
 * committed, and the DELETE's fresh snapshot sees it, or has to wait for us.
 */
async function deletePosts(ids: readonly string[], remote: ReadonlySet<string>): Promise<string[]> {
  if (ids.length === 0) return [];
  const remoteIds = [...remote];
  const remoteArray = textArray(remoteIds);
  const outside = (column: SQL) => sql`not (${column} = any(${remoteArray}))`;
  return getDb().transaction(async (tx) => {
    // Id order, the order `deletePostSubtree` locks in.
    await tx.execute(sql`
      select id from posts where id = any(${textArray(ids)}) order by id for update
    `);
    // Every rule again, against the fresh snapshot.
    const mayGo = sql`
      p.visibility = 'public' and p.status = 'published'
      and not (${ANY_SQL_RULE})
      and not exists (select 1 from engagement_outbox eo where eo.payload_post_id = p.id)
      and not exists (select 1 from post_promotions pp where pp.post_id = p.id)
      and not exists (select 1 from likes l where l.post_id = p.id and ${outside(sql`l.user_id`)})
      and not exists (select 1 from post_authorships pa where pa.post_id = p.id and ${outside(sql`pa.oxy_user_id`)})
      and not exists (select 1 from post_mentions pm where pm.post_id = p.id and ${outside(sql`pm.oxy_user_id`)})
      and (p.oxy_user_id is null or p.oxy_user_id = any(${remoteArray}))
      and (p.community_oxy_user_id is null or p.community_oxy_user_id = any(${remoteArray}))
    `;
    const eligible = await tx.execute<{ id: string }>(sql`
      select p.id from posts p where p.id = any(${textArray(ids)}) and ${mayGo}
    `);
    if (eligible.length === 0) return [];
    const doomed = eligible.map((row) => row.id);
    // Before the rows cascade away: afterwards nothing names the re-hosted files.
    await enqueueFederatedMediaDeletionsForPosts(doomed, tx);
    const rows = await tx.execute<{ id: string }>(sql`
      delete from posts p where p.id = any(${textArray(doomed)}) and ${mayGo}
      returning p.id
    `);
    return rows.map((row) => row.id);
  });
}

// ── The runner ──────────────────────────────────────────────────────────────

export type RetentionPhase = 'posts' | 'follow-edges';

export interface FederatedRetentionOptions {
  dryRun: boolean;
  phases?: readonly RetentionPhase[];
  postMaxAgeDays?: number;
  keepNewestPerFollowedAuthor?: number;
  edgeUnknownTtlDays?: number;
  postBatchSize?: number;
  edgeBatchSize?: number;
  /** Posts scanned this run. */
  limit?: number;
  /** Start a fresh walk at this `created_at`. */
  startAt?: Date;
  resetCursor?: boolean;
  gate?: RetentionBatchGate;
  classifyRemote?: RemoteAccountClassifier;
  now?: Date;
}

export interface PostRetentionReport {
  cutoff: Date;
  scanned: number;
  /** External posts the walk visited (the rest are local, kept). */
  external: number;
  /** Would be deleted (dry run) / were deleted. */
  deletable: number;
  deleted: number;
  deletableByType: Record<string, number>;
  /**
   * Posts kept, per reason. Every SQL rule that holds is counted; `localAccount`
   * and `newestOfFollowedAuthor` only for a post no SQL rule kept.
   */
  keptBy: Record<PostKeepReason, number>;
  /** Batches the preflight refused; nothing in them was deleted. */
  preflightBlocked: number;
  /** Posts the DELETE's own re-check kept (a reference appeared mid-batch). */
  keptAtDelete: number;
  cursorWriteFailed: number;
  passCompleted: boolean;
  stopped?: RetentionStoppedError['reason'];
}

export interface EdgeRetentionReport {
  cutoff: Date;
  estimatedEdges: number;
  sampled: number;
  sampledUnknownEnd: number;
  sampledExpirable: number;
  deleted: number;
  stopped?: RetentionStoppedError['reason'];
}

export interface FederatedRetentionReport {
  dryRun: boolean;
  posts?: PostRetentionReport;
  followEdges?: EdgeRetentionReport;
}

function emptyKeptBy(): Record<PostKeepReason, number> {
  return Object.fromEntries(POST_KEEP_REASONS.map((reason) => [reason, 0])) as Record<
    PostKeepReason,
    number
  >;
}

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return `${row.createdAt.toISOString()}|${row.id}`;
}

function decodeCursor(raw: string): { createdAt: Date; id: string } | null {
  const bar = raw.indexOf('|');
  if (bar <= 0) return null;
  const createdAt = new Date(raw.slice(0, bar));
  return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id: raw.slice(bar + 1) };
}

export async function prunePosts(opts: FederatedRetentionOptions): Promise<PostRetentionReport> {
  const now = opts.now ?? new Date();
  const maxAgeDays = opts.postMaxAgeDays ?? DEFAULT_POST_MAX_AGE_DAYS;
  if (!(maxAgeDays >= MIN_POST_MAX_AGE_DAYS)) {
    throw new Error(
      `[${SCRIPT_NAME}] refusing a post age under ${MIN_POST_MAX_AGE_DAYS} days (got ${maxAgeDays})`,
    );
  }
  const cutoff = new Date(now.getTime() - maxAgeDays * DAY_MS);
  const batchSize = opts.postBatchSize ?? DEFAULT_POST_BATCH_SIZE;
  const limit = opts.limit ?? (opts.dryRun ? DEFAULT_DRY_RUN_LIMIT : Number.POSITIVE_INFINITY);
  const gate = opts.gate ?? fixedPauseGate(0);
  const classifyRemote = opts.classifyRemote ?? createRemoteAccountClassifier();
  const newestOfFollowed = createFollowedAuthorWindow(
    opts.keepNewestPerFollowedAuthor ?? DEFAULT_KEEP_NEWEST_PER_FOLLOWED_AUTHOR,
  );

  const report: PostRetentionReport = {
    cutoff,
    scanned: 0,
    external: 0,
    deletable: 0,
    deleted: 0,
    deletableByType: {},
    keptBy: emptyKeptBy(),
    preflightBlocked: 0,
    keptAtDelete: 0,
    cursorWriteFailed: 0,
    passCompleted: false,
  };

  if (opts.resetCursor && !opts.dryRun) await clearAdminScriptCursor(SCRIPT_NAME, POSTS_SCOPE);
  let after: { createdAt: Date; id: string } | null = null;
  let scannedInPass = 0;
  if (opts.startAt) {
    after = { createdAt: opts.startAt, id: '' };
  } else if (!opts.resetCursor) {
    const saved = await readAdminScriptCursor(SCRIPT_NAME, POSTS_SCOPE);
    // A finished pass starts a new one from the oldest post.
    if (saved && !saved.completedAt) {
      after = decodeCursor(saved.cursor);
      scannedInPass = saved.scanned;
    }
  }

  try {
    while (report.scanned < limit) {
      await gate.beforeBatch({
        cursor: after ? encodeCursor(after) : null,
        scope: POSTS_SCOPE,
        scanned: scannedInPass,
      });
      const page = await readPage(cutoff, after, Math.min(batchSize, limit - report.scanned));
      if (page.length === 0) {
        report.passCompleted = true;
        if (!opts.dryRun && after) {
          const ok = await recordAdminScriptCursor(SCRIPT_NAME, POSTS_SCOPE, {
            cursor: encodeCursor(after),
            scanned: scannedInPass,
            completed: true,
          });
          if (!ok) report.cursorWriteFailed += 1;
        }
        break;
      }

      const facts = await loadFacts(page.map((row) => row.id));
      const remote = await classifyRemote([...new Set(facts.flatMap((fact) => fact.accounts))]);
      const open = facts.filter((fact) => fact.sqlReasons.length === 0);
      const windowed = await newestOfFollowed(open);

      const doomed: PostRetentionFacts[] = [];
      for (const fact of facts) {
        if (!fact.sqlReasons.includes('local')) report.external += 1;
        const decision = decidePostRetention(fact, remote, windowed.has(fact.id));
        if (decision.delete) {
          doomed.push(fact);
          continue;
        }
        for (const reason of decision.keptBy) report.keptBy[reason] += 1;
      }
      report.deletable += doomed.length;
      for (const fact of doomed) {
        report.deletableByType[fact.type] = (report.deletableByType[fact.type] ?? 0) + 1;
      }

      if (!opts.dryRun && doomed.length > 0) {
        try {
          await assertPostsSafeToDelete(
            SCRIPT_NAME,
            doomed.map((fact) => ({ id: fact.id, uris: fact.uris })),
            { removedByCascade: RETENTION_ACKNOWLEDGED_CASCADES },
          );
          const deleted = await deletePosts(
            doomed.map((fact) => fact.id),
            remote,
          );
          report.deleted += deleted.length;
          report.keptAtDelete += doomed.length - deleted.length;
        } catch (error) {
          if (!(error instanceof DeletionPreflightError)) throw error;
          // Fail closed on the batch, never on the run.
          logger.warn(`[${SCRIPT_NAME}] deletion preflight refused a batch; nothing removed`, {
            batchSize: doomed.length,
            blockers: error.blockers,
          });
          report.preflightBlocked += 1;
        }
      }

      const last = page[page.length - 1];
      after = { createdAt: new Date(last.created_at), id: last.id };
      report.scanned += page.length;
      scannedInPass += page.length;
      if (!opts.dryRun) {
        const ok = await recordAdminScriptCursor(SCRIPT_NAME, POSTS_SCOPE, {
          cursor: encodeCursor(after),
          scanned: scannedInPass,
        });
        if (!ok) report.cursorWriteFailed += 1;
      }
    }
  } catch (error) {
    if (!(error instanceof RetentionStoppedError)) throw error;
    report.stopped = error.reason;
  }
  return report;
}

/** Measure (dry run) or drain (live) the unknown-end expiry of `remote_follow_edges`. */
export async function pruneFollowEdges(
  opts: FederatedRetentionOptions,
): Promise<EdgeRetentionReport> {
  const now = opts.now ?? new Date();
  const ttlDays = opts.edgeUnknownTtlDays ?? DEFAULT_EDGE_UNKNOWN_TTL_DAYS;
  if (!(ttlDays >= 1)) throw new Error(`[${SCRIPT_NAME}] edge TTL must be at least 1 day`);
  const cutoff = unknownEdgeExpiryCutoff(now, ttlDays * DAY_MS);
  const batchSize = opts.edgeBatchSize ?? DEFAULT_EDGE_BATCH_SIZE;
  const gate = opts.gate ?? fixedPauseGate(0);

  const [estimate] = await getDb().execute<{ estimate: number }>(sql`
    select greatest(reltuples, 0)::bigint::int as estimate from pg_class
    where oid = 'remote_follow_edges'::regclass
  `);
  // A 0.1% block sample: about 550 pages of the production heap, never the whole table.
  const [sample] = await getDb().execute<{
    sampled: number;
    unknown_end: number;
    expirable: number;
  }>(sql`
    with s as (
      select e.last_seen_at,
        not (${knownNode(sql`src.uri`)} and ${knownNode(sql`dst.uri`)}) as unknown_end
      from remote_follow_edges e tablesample system (0.1)
      join remote_actor_refs src on src.id = e.source_id
      join remote_actor_refs dst on dst.id = e.target_id
    )
    select count(*)::int as sampled,
      count(*) filter (where unknown_end)::int as unknown_end,
      count(*) filter (where unknown_end and last_seen_at < ${cutoff.toISOString()}::timestamptz)::int as expirable
    from s
  `);
  const report: EdgeRetentionReport = {
    cutoff,
    estimatedEdges: Number(estimate?.estimate ?? 0),
    sampled: Number(sample?.sampled ?? 0),
    sampledUnknownEnd: Number(sample?.unknown_end ?? 0),
    sampledExpirable: Number(sample?.expirable ?? 0),
    deleted: 0,
  };
  if (opts.dryRun) return report;

  try {
    for (;;) {
      await gate.beforeBatch({ scope: 'follow-edges', scanned: report.deleted });
      const deleted = await expireUnknownRemoteFollowEdges(cutoff, batchSize);
      report.deleted += deleted;
      if (deleted < batchSize) break;
    }
  } catch (error) {
    if (!(error instanceof RetentionStoppedError)) throw error;
    report.stopped = error.reason;
  }
  return report;
}

/** The same known-account test as `remoteGraphRepository`'s `knownNodeSql`. */
function knownNode(node: SQL): SQL {
  return sql`exists (select 1 from federated_actors fa
    where fa.uri = any(array[${node}, ${BRIDGY_BSKY_ACTOR_PREFIX} || ${node}])
      and fa.oxy_user_id is not null)`;
}

/** Both phases. The CALLER owns the connection lifecycle, so a test can run it in-process. */
export async function pruneFederatedRetention(
  opts: FederatedRetentionOptions,
): Promise<FederatedRetentionReport> {
  const phases = opts.phases ?? ['posts', 'follow-edges'];
  const report: FederatedRetentionReport = { dryRun: opts.dryRun };
  if (phases.includes('posts')) {
    report.posts = await prunePosts(opts);
    if (report.posts.stopped) return report;
  }
  if (phases.includes('follow-edges')) report.followEdges = await pruneFollowEdges(opts);
  return report;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function positiveIntEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0 || String(value) !== raw) {
    throw new Error(`${name} must be a positive integer (got "${raw}")`);
  }
  return value;
}

function readPhases(): RetentionPhase[] {
  const raw = process.env.RETENTION_PHASES?.trim();
  if (!raw) return ['posts', 'follow-edges'];
  const phases = raw.split(',').map((phase) => phase.trim());
  for (const phase of phases) {
    if (phase !== 'posts' && phase !== 'follow-edges') {
      throw new Error(`RETENTION_PHASES: unknown phase "${phase}"`);
    }
  }
  return phases as RetentionPhase[];
}

async function main(): Promise<number> {
  const dryRun = (process.env.DRY_RUN ?? 'true').trim().toLowerCase() !== 'false';
  assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun });
  const startRaw = process.env.RETENTION_START_AT?.trim();
  const startAt = startRaw ? new Date(startRaw) : undefined;
  if (startAt && Number.isNaN(startAt.getTime())) {
    throw new Error(`RETENTION_START_AT=${startRaw} is not a date`);
  }
  const options: FederatedRetentionOptions = {
    dryRun,
    phases: readPhases(),
    postMaxAgeDays: positiveIntEnv('RETENTION_POST_MAX_AGE_DAYS'),
    keepNewestPerFollowedAuthor: positiveIntEnv('RETENTION_KEEP_NEWEST_PER_FOLLOWED_AUTHOR'),
    edgeUnknownTtlDays: positiveIntEnv('RETENTION_EDGE_UNKNOWN_TTL_DAYS'),
    postBatchSize: positiveIntEnv('RETENTION_BATCH_SIZE'),
    edgeBatchSize: positiveIntEnv('RETENTION_BATCH_SIZE'),
    limit: positiveIntEnv('RETENTION_LIMIT'),
    startAt,
    resetCursor: ['1', 'true', 'yes'].includes(
      (process.env.RESET_CURSOR ?? '').trim().toLowerCase(),
    ),
    // TODO(#2058): createBackfillThrottle({ script: SCRIPT_NAME, pauseMs: 250, dryRun }).
    gate: createRetentionGate({
      window: parseRetentionWindow(process.env.RETENTION_WINDOW_UTC),
      pauseMs: 250,
      slowBatchMs: positiveIntEnv('RETENTION_SLOW_BATCH_MS') ?? 30_000,
      maxConsecutiveSlow: 3,
    }),
  };

  await connectPostgres();
  logger.info(`[${SCRIPT_NAME}] starting`, {
    dryRun,
    phases: options.phases,
    postMaxAgeDays: options.postMaxAgeDays ?? DEFAULT_POST_MAX_AGE_DAYS,
  });
  const report = await pruneFederatedRetention(options);
  if (report.posts) {
    const { keptBy, deletableByType, ...totals } = report.posts;
    logger.info(`[${SCRIPT_NAME}] posts`, totals);
    logger.info(`[${SCRIPT_NAME}] posts kept by reason`, keptBy);
    // Counted at selection: on a dry run these would go, on a live run they were offered to the delete.
    logger.info(`[${SCRIPT_NAME}] posts deletable by type`, deletableByType);
  }
  if (report.followEdges) logger.info(`[${SCRIPT_NAME}] follow edges`, { ...report.followEdges });

  const stopped = report.posts?.stopped ?? report.followEdges?.stopped;
  if (stopped) return EXIT_RETENTION_STOPPED;
  if ((report.posts?.preflightBlocked ?? 0) > 0 || (report.posts?.cursorWriteFailed ?? 0) > 0) {
    return 1;
  }
  return 0;
}

if (require.main === module) {
  main()
    .then(async (code) => {
      await closeAdminScriptResources();
      process.exit(code);
    })
    .catch(async (error) => {
      logger.error(`[${SCRIPT_NAME}] failed`, {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      await closeAdminScriptResources().catch(() => undefined);
      process.exit(1);
    });
}
