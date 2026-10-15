/**
 * Every index on `posts` is classified, exists, and is declared exactly as
 * written here.
 *
 * ## Why an index needs a test of its own
 *
 * An index is the one thing a functional test can never detect the absence of.
 * Drop `post_authorships_author_chrono_idx` and every profile-feed test in this
 * repository still passes: the same rows come back in the same order, and the
 * only difference is that the planner walks a chronological index over the whole
 * of `posts` probing `post_authorships` per candidate row — 84–99 ms and 42,394
 * probes for a page of 21 on an ordinary account, versus under a millisecond
 * (measured on 624k posts; `drizzle/0021_faithful_bloodstrike.sql` carries the
 * numbers). Nothing errors, nothing is wrong, the feed is just slow, and nobody
 * attributes it to the index that went missing three months earlier.
 *
 * Two realistic ways one goes missing, neither of them a deletion anybody
 * reviewed as such:
 *
 *   * a GENERATED column's expression changes, and `drizzle-kit generate` emits
 *     `DROP COLUMN` + `ADD COLUMN` — which takes every index over that column
 *     with it and re-emits none of them. `posts.geo` and `posts.content_geo` are
 *     generated and carry two of the indexes below;
 *   * an index is regenerated with drizzle's query-side default spelling, so it
 *     declares `DESC NULLS FIRST`. It exists, it is the right columns, and
 *     Postgres will not use it for the order the code asks for. That is the
 *     failure `chronoOrderPlan.test.ts` exists for, and this file is the half of
 *     it that names the index rather than iterating whatever happens to match.
 *
 * ## Why the map is EXHAUSTIVE over `posts`
 *
 * A gate that skips what is missing from a hand-maintained map is not a gate.
 * `everyPostsIndexIsClassified` asserts the catalogue's set of `posts` indexes
 * EQUALS this file's, so a new index that nobody classified fails the build and
 * a dropped one fails it too. That is the whole output of the #753 audit: not a
 * verdict frozen in a document, but a list that stops being true out loud.
 *
 * Each entry states what pays when it is gone, so a failure reads as an
 * instruction rather than a name — and, for the four indexes the audit narrowed
 * to partial, what makes the narrowing safe.
 *
 * ## Why the whole `indexdef`, and why by NAME
 *
 * The definition, because "an index called X exists" is satisfied by an index on
 * the wrong columns in the wrong order with the wrong NULLS placement — and,
 * since the audit, by one whose partial predicate has quietly widened or
 * narrowed. By name, because `chronoOrderPlan.test.ts` asserts a PROPERTY over
 * every `posts` index matching a pattern (`created_at desc`), and its vacuity
 * floor is a count: an index that disappears leaves that loop iterating nine
 * instead of ten and green either way. A property over a set and the membership
 * of that set are two claims.
 *
 * ## What this file deliberately does not do
 *
 * It runs no `EXPLAIN` against `posts`. Asserting a plan over that table asserts
 * the planner's CHOICE among two dozen candidate indexes, which moves with the
 * statistics every other file in a parallel run changes —
 * `chronoOrderPlan.test.ts` shipped that and it was flaky twice in eight runs.
 * The property asserted above is what the DDL DECLARES.
 *
 * The plan assertions here are the other shape: a private temp table that
 * shadows `posts` on one connection, `on commit drop` inside one transaction,
 * where the planner chooses among the migration's own indexes and no other file
 * can be writing rows.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';

/**
 * One index, its exact definition, and what pays when it is gone.
 *
 * The definition is the `pg_indexes.indexdef` a migrated database reports, minus
 * nothing — schema qualification, `USING btree`, and the normalised partial
 * predicate included, because a change to any of them is a change worth reading.
 */
interface ClassifiedIndex {
  name: string;
  table: string;
  /** What breaks — slowly, silently — if this index stops existing. */
  serves: string;
  definition: string;
}

/**
 * Every index on `posts`, classified. Order follows `db/schema/posts.ts`.
 *
 * Measured on 2026-08-15 against a private PostGIS 17 container seeded to 300k
 * posts (200k roots / 100k replies, 12k authors, production-shaped
 * distributions) — NOT production, and not the shared dev database. Sizes quoted
 * in `serves` are from that corpus and are proportional, not absolute.
 */
const POSTS_INDEXES: readonly ClassifiedIndex[] = [
  {
    name: 'posts_pkey',
    table: 'posts',
    serves:
      'the primary key — every id lookup, and the target of five self-referencing foreign keys',
    definition: 'CREATE UNIQUE INDEX posts_pkey ON public.posts USING btree (id)',
  },
  {
    name: 'posts_federation_activity_id_key',
    table: 'posts',
    serves:
      'federation dedup — a CONSTRAINT, not a performance index: it is the only identity a remote ' +
      'instance guarantees for an activity, and dropping it duplicates every redelivered Announce',
    definition:
      'CREATE UNIQUE INDEX posts_federation_activity_id_key ON public.posts ' +
      'USING btree (federation_activity_id) WHERE (federation_activity_id IS NOT NULL)',
  },
  {
    name: 'posts_federation_actor_author_idx',
    table: 'posts',
    serves:
      'source identity projection and cache inspection — avoid scanning all posts for each immutable ' +
      "source actor; `oxy_user_id` in the key lets the projection find the source's posts that do not " +
      'carry its author yet from the index entries, instead of one heap page per post (0069)',
    definition:
      'CREATE INDEX posts_federation_actor_author_idx ON public.posts ' +
      'USING btree (federation_actor_uri, oxy_user_id) WHERE (federation_actor_uri IS NOT NULL)',
  },
  {
    name: 'posts_federation_url_idx',
    table: 'posts',
    serves: 'resolving a remote note URL to our copy (Threads quotes) without scanning every post',
    definition:
      'CREATE INDEX posts_federation_url_idx ON public.posts ' +
      'USING btree (federation_url) WHERE (federation_url IS NOT NULL)',
  },
  {
    name: 'post_public_chrono_v1',
    table: 'posts',
    serves:
      'every public chronological scan that does NOT fix `is_reply` — post search with no operators, ' +
      "and the feed engine's `fetchChrono`. Reachability is not assumed: the negative control in this " +
      'file drives a query onto it and reads it back out of the plan',
    definition:
      'CREATE INDEX post_public_chrono_v1 ON public.posts ' +
      'USING btree (visibility, status, created_at DESC NULLS LAST, id DESC NULLS LAST)',
  },
  {
    name: 'posts_roots_chrono_idx',
    table: 'posts',
    serves:
      'the root feeds, which all fix `is_reply = false`. Its key columns are IDENTICAL to ' +
      '`post_public_chrono_v1` and it is still not redundant with it, in either direction: this one is ' +
      'the size of the root set and applies the filter the planner would otherwise re-check per row, ' +
      'and the full one serves the queries that carry no `is_reply` term at all',
    definition:
      'CREATE INDEX posts_roots_chrono_idx ON public.posts ' +
      'USING btree (visibility, status, created_at DESC NULLS LAST, id DESC NULLS LAST) ' +
      'WHERE (is_reply = false)',
  },
  {
    name: 'post_replies_chrono_v1',
    table: 'posts',
    serves: "a post's replies, newest- or oldest-first (the index is read backwards for ascending)",
    definition:
      'CREATE INDEX post_replies_chrono_v1 ON public.posts ' +
      'USING btree (parent_post_id, visibility, status, created_at DESC NULLS LAST, id DESC NULLS LAST)',
  },
  {
    name: 'posts_owner_chrono_idx',
    table: 'posts',
    serves:
      "the profile feed's owner branch (`fetchAuthored`, mtn/feed/engine/sources/userSources.ts) — the " +
      'denormalized owner reached chronologically, the cheaper of the two routes the `union` merges',
    definition:
      'CREATE INDEX posts_owner_chrono_idx ON public.posts ' +
      'USING btree (oxy_user_id, visibility, status, created_at DESC NULLS LAST, id DESC NULLS LAST)',
  },
  {
    name: 'posts_created_at_idx',
    table: 'posts',
    serves:
      'a chronological scan carrying no visibility/status term. It is the ONLY index on this table whose ' +
      'leading column is `created_at`, so nothing else can serve that shape — which is also why the ' +
      "audit's left-prefix rule does not condemn it despite being one column wide",
    definition:
      'CREATE INDEX posts_created_at_idx ON public.posts USING btree (created_at DESC NULLS LAST)',
  },
  {
    name: 'posts_public_author_recent_idx',
    table: 'posts',
    serves:
      'which accounts published publicly inside a window — `followerSnapshotJob.selectAuthorsToSample`, ' +
      'as an index-only range instead of a sequential scan of every post (#1166). Neither key column is ' +
      'written after insert, so it costs the engagement counters no HOT update',
    definition:
      'CREATE INDEX posts_public_author_recent_idx ON public.posts ' +
      "USING btree (created_at, oxy_user_id) WHERE ((visibility = 'public'::text) AND (status = 'published'::text))",
  },
  {
    name: 'posts_thread_idx',
    table: 'posts',
    serves:
      'the self-thread spine — `feed.controller.getSelfThreadContinuations` and `ThreadSlicingService`, ' +
      'both `eq(thread_id, X)`. NARROWED to partial by the #753 audit (23 MB → 2992 kB): ~90% of its ' +
      'entries were rows with a NULL `thread_id` that no query reaching it can return, and no predicate ' +
      'anywhere in the tree asks for that side',
    definition:
      'CREATE INDEX posts_thread_idx ON public.posts ' +
      'USING btree (thread_id, oxy_user_id, parent_post_id, created_at) WHERE (thread_id IS NOT NULL)',
  },
  {
    name: 'posts_boost_of_idx',
    table: 'posts',
    serves:
      '"who boosted this post" — `inArray(posts.boostOf, ids)` in the deletion cascade, engagement ' +
      'recompute and the AP inbox. KEPT FULL although `boost_of` is NULL on ~95% of rows: ' +
      '`notABoostSql()` is `isNull(posts.boostOf)` and runs on hot feed paths, so a partial index ' +
      'excluding NULLs would silently stop being available to them',
    definition:
      'CREATE INDEX posts_boost_of_idx ON public.posts USING btree (boost_of, created_at DESC NULLS LAST)',
  },
  {
    name: 'posts_one_boost_per_account_key',
    table: 'posts',
    serves:
      'one NATIVE boost per account per post — a CONSTRAINT. `federation_activity_id is null` in the ' +
      'predicate is load-bearing: widen it and a re-Announced remote boost 23505s inside the inbox ' +
      'worker, which retries forever',
    definition:
      'CREATE UNIQUE INDEX posts_one_boost_per_account_key ON public.posts USING btree (oxy_user_id, boost_of) ' +
      "WHERE ((type = 'boost'::text) AND (boost_of IS NOT NULL) AND (federation_activity_id IS NULL))",
  },
  {
    name: 'posts_quote_of_idx',
    table: 'posts',
    serves:
      'quotes of a given post. KEPT FULL for the same reason as `posts_boost_of_idx` — ' +
      '`scripts/backfillQuotedPosts.ts` spells `isNull(posts.quoteOf)`',
    definition:
      'CREATE INDEX posts_quote_of_idx ON public.posts USING btree (quote_of, created_at DESC NULLS LAST)',
  },
  {
    name: 'posts_scheduled_idx',
    table: 'posts',
    serves:
      'the site-wide scheduled SWEEP, which wants every due post regardless of owner. Partial, so it ' +
      'indexes a set that drains every 60 seconds rather than the table',
    definition:
      "CREATE INDEX posts_scheduled_idx ON public.posts USING btree (scheduled_for) WHERE (status = 'scheduled'::text)",
  },
  {
    name: 'post_owner_scheduled_v1',
    table: 'posts',
    serves:
      "ONE account's queue — `GET /posts/scheduled`. `posts_scheduled_idx` cannot serve it (wrong leading " +
      "column), which is why both exist: without this one a member's queue read costs a scan " +
      'proportional to how much everybody else has scheduled',
    definition:
      'CREATE INDEX post_owner_scheduled_v1 ON public.posts USING btree (oxy_user_id, scheduled_for) ' +
      "WHERE (status = 'scheduled'::text)",
  },
  {
    name: 'post_lane_chrono_v1',
    table: 'posts',
    serves: "the lane tab's keyset — `laneSource` pages ONE lane on `(created_at, id)`",
    definition:
      'CREATE INDEX post_lane_chrono_v1 ON public.posts ' +
      'USING btree (lane_id, visibility, status, created_at DESC NULLS LAST, id DESC NULLS LAST) ' +
      'WHERE (lane_id IS NOT NULL)',
  },
  {
    name: 'posts_crosspost_collapsed_idx',
    table: 'posts',
    serves:
      'counting and enumerating collapsed cross-post variants — the reconciliation report and the ' +
      "planner's estimate for `crosspost_collapsed is not true`. PARTIAL on the TRUE side, which is a " +
      'vanishing fraction of rows: the feed predicate excludes them and is served by the ordinary ' +
      'chrono indexes, so indexing the 99.99% that pass would be indexing absence',
    definition:
      'CREATE INDEX posts_crosspost_collapsed_idx ON public.posts USING btree (crosspost_collapsed) ' +
      'WHERE crosspost_collapsed',
  },
  {
    name: 'posts_hashtags_gin',
    table: 'posts',
    serves: 'hashtag feeds and `trendTermMatchSql` — an array overlap a btree cannot serve at all',
    definition: 'CREATE INDEX posts_hashtags_gin ON public.posts USING gin (hashtags)',
  },
  {
    name: 'posts_hashtags_trgm_gin',
    table: 'posts',
    serves:
      "`GET /hashtags/search`'s coarse filter (routes/hashtags.ts) — a per-element " +
      "SUBSTRING match (`LIKE '%needle%'` on an unnested tag), which " +
      '`posts_hashtags_gin` (a MEMBERSHIP index) cannot accelerate at all. Trigram ' +
      '(`pg_trgm`) over the concatenated tags, via the IMMUTABLE wrapper ' +
      '`posts_hashtags_search_text` an index expression on the merely-STABLE ' +
      '`array_to_string` cannot be',
    definition:
      'CREATE INDEX posts_hashtags_trgm_gin ON public.posts USING gin ' +
      '(posts_hashtags_search_text(hashtags) gin_trgm_ops) ' +
      "WHERE ((visibility = 'public'::text) AND (COALESCE(cardinality(hashtags), 0) > 0))",
  },
  {
    name: 'posts_classification_topics_gin',
    table: 'posts',
    serves: 'topic-matched feed candidates and the trend term space',
    definition:
      'CREATE INDEX posts_classification_topics_gin ON public.posts USING gin (classification_topics)',
  },
  {
    name: 'posts_classification_languages_gin',
    table: 'posts',
    serves: "language-matched feed candidates and search's `language=` filter",
    definition:
      'CREATE INDEX posts_classification_languages_gin ON public.posts USING gin (classification_languages)',
  },
  {
    name: 'posts_classification_trend_terms_gin',
    table: 'posts',
    serves: '`trendTermMatchSql` — trend detection, trend feeds and excerpt lookup',
    definition:
      'CREATE INDEX posts_classification_trend_terms_gin ON public.posts USING gin (classification_trend_terms)',
  },
  {
    name: 'posts_classification_region_idx',
    table: 'posts',
    serves:
      'region-matched feed candidates (`forYouCandidateSources`, `relatedSources`). NARROWED to partial ' +
      'by the #753 audit (9264 kB → 2080 kB); the only predicates are `eq(classification_region, X)` and ' +
      'nothing asks for the unclassified side',
    definition:
      'CREATE INDEX posts_classification_region_idx ON public.posts ' +
      'USING btree (classification_region, created_at DESC NULLS LAST) WHERE (classification_region IS NOT NULL)',
  },
  {
    name: 'posts_curated_idx',
    table: 'posts',
    serves:
      'curated posts, newest first. Partial, and NOT redundant with `posts_created_at_idx` despite the ' +
      'identical key: the total index is what a naive left-prefix rule would keep, and it is the one ' +
      'that cannot apply the `curated` filter',
    definition:
      'CREATE INDEX posts_curated_idx ON public.posts USING btree (created_at DESC NULLS LAST) WHERE (curated IS TRUE)',
  },
  {
    name: 'posts_engagement_rank_idx',
    table: 'posts',
    serves:
      'the popular / never-blank discovery scans, whose ORDER BY is a COMPUTED engagement composite. ' +
      'Without it the planner has one option — read every candidate row and top-N sort it — so the cost ' +
      'is bounded by the TABLE while the answer stays 60 rows, and the unbounded pass of ' +
      '`fetchWithRecencyFallback` (reached on every page by a reader whose languages underfill 7d and 30d) ' +
      'sorted the whole archive: 17.25s in production, 77-89ms against 275k posts here, 0.11-0.26ms with ' +
      'this index. `engagementRankIndex.test.ts` is the half that checks the EXPRESSION still matches the ' +
      'query, which is what actually decides whether the planner can use it',
    definition:
      'CREATE INDEX posts_engagement_rank_idx ON public.posts USING btree ' +
      '(((((((stats_likes_count)::double precision * (1)::double precision) + ' +
      '((GREATEST(0, (stats_boosts_count - stats_federated_boosts_count)))::double precision * ' +
      '(2.5)::double precision)) + ((stats_federated_boosts_count)::double precision * ' +
      '(0.5)::double precision)) + ((stats_comments_count)::double precision * (2)::double precision))) ' +
      'DESC, created_at DESC NULLS LAST, id DESC NULLS LAST) ' +
      "WHERE ((visibility = 'public'::text) AND (status = 'published'::text))",
  },
  {
    name: 'posts_geo_gist',
    table: 'posts',
    serves:
      '`ST_DWithin` on the post location — the `nearby` controller. NARROWED to partial by the #753 ' +
      'audit (20 MB → 488 kB, the single largest win): a GiST index indexes NULLs too, so the full form ' +
      'paid an insert on every ordinary post for an entry no proximity query can match',
    definition:
      'CREATE INDEX posts_geo_gist ON public.posts USING gist (geo) WHERE (geo IS NOT NULL)',
  },
  {
    name: 'posts_content_geo_gist',
    table: 'posts',
    serves:
      '`ST_DWithin` on the content location. NARROWED with `posts_geo_gist` (19 MB → 264 kB); the ' +
      'controller ORs the two, which still plans as a `BitmapOr` over both partial indexes',
    definition:
      'CREATE INDEX posts_content_geo_gist ON public.posts USING gist (content_geo) WHERE (content_geo IS NOT NULL)',
  },
];

/**
 * Indexes on OTHER tables that a measured hot path depends on.
 *
 * Deliberately not exhaustive over their tables — the #753 audit's subject was
 * `posts`, and a map claiming completeness it has not measured would be worse
 * than one that says where its edge is. Widen it by auditing a table, not by
 * appending to this list.
 */
const OTHER_TABLE_INDEXES: readonly ClassifiedIndex[] = [
  {
    name: 'post_authorships_author_chrono_idx',
    table: 'post_authorships',
    serves:
      "the profile feed's authorship branch (`fetchAuthored`) — author, accepted, newest first, in one " +
      'index, which is why `post_created_at` is copied onto that table at all',
    definition:
      'CREATE INDEX post_authorships_author_chrono_idx ON public.post_authorships ' +
      'USING btree (oxy_user_id, status, post_created_at DESC NULLS LAST, post_id DESC NULLS LAST)',
  },
  {
    name: 'post_media_video_chrono_idx',
    table: 'post_media',
    serves:
      'the global Videos lane, whose scan drives from `post_media` precisely so this index can answer ' +
      'it — matching video media of one orientation, newest first, in one index. Without it the lane ' +
      'walks a chronological index over `posts` probing this table once per candidate, and the walk is ' +
      'as long as the seen set makes it: measured on 275k posts (39,285 video), page of 60 with the ' +
      'full 1,000-id seen set, 7,554 posts probed and 33,032 buffers against 377 media rows and 1,916. ' +
      '`videosLaneChrono.test.ts` is the half that checks the lane still PLANS onto it',
    definition:
      'CREATE INDEX post_media_video_chrono_idx ON public.post_media ' +
      'USING btree (type, orientation, post_created_at DESC NULLS LAST, post_id DESC NULLS LAST)',
  },
];

const ALL_INDEXES: readonly ClassifiedIndex[] = [...POSTS_INDEXES, ...OTHER_TABLE_INDEXES];

let db: Database;

beforeAll(async () => {
  db = await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

/** `pg_indexes.indexdef` for `name`, or null when no such index exists. */
async function indexDefinition(name: string): Promise<string | null> {
  const rows = await db.execute<{ indexdef: string }>(
    sql`select indexdef from pg_indexes where schemaname = 'public' and indexname = ${name}`,
  );
  return [...rows][0]?.indexdef ?? null;
}

/** Every index the catalogue holds for `table`. */
async function catalogueIndexNames(table: string): Promise<string[]> {
  const rows = await db.execute<{ indexname: string }>(
    sql`select indexname from pg_indexes where schemaname = 'public' and tablename = ${table} order by indexname`,
  );
  return [...rows].map((row) => row.indexname);
}

describe('the indexes the measured hot paths are built on', () => {
  it('can read index definitions at all — the vacuity floor', async () => {
    /**
     * Every assertion below compares against a value read out of `pg_indexes`,
     * and a query that matched nothing would report every index missing — which
     * is a legible failure — but a query that matched nothing while the SET was
     * also empty is how a renamed catalogue view reads. So: the tables carry
     * indexes, plainly, before any of them is named.
     */
    const rows = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_indexes
      where schemaname = 'public' and tablename in ('posts', 'post_authorships')
    `);
    expect([...rows][0]?.n ?? 0).toBeGreaterThanOrEqual(20);
  });

  it('reports an index that does not exist as absent — the negative control', async () => {
    // Without this, "the definition matched" is the only outcome the helper has
    // ever been observed to produce, and a helper that returned a definition for
    // every name would satisfy the whole file.
    await expect(indexDefinition('post_authorships_no_such_index')).resolves.toBeNull();
  });

  it.each(ALL_INDEXES)('$name exists, on $table', async ({ name, table, serves }) => {
    const definition = await indexDefinition(name);
    expect(definition, `${name} is missing — it serves ${serves}`).not.toBeNull();
    expect(definition).toContain(`ON public.${table} `);
  });

  it.each(ALL_INDEXES)(
    '$name is declared exactly as the query reads it',
    async ({ name, definition }) => {
      /**
       * Three things ride on the exact text, and none has a functional symptom:
       * the NULLS placement (Postgres matches an index to an ORDER BY on it, so
       * drizzle's query-side default `DESC NULLS FIRST` is present, correct and
       * unusable), the column order, and — since the #753 audit — the partial
       * predicate. A predicate that widens costs the disk the audit recovered; one
       * that narrows makes the index unusable by the query it was cut for.
       */
      await expect(indexDefinition(name)).resolves.toBe(definition);
    },
  );
});

describe('the classification of `posts` indexes is exhaustive', () => {
  it('classifies every index the catalogue holds, and holds every index it classifies', async () => {
    /**
     * The output of the #753 audit, expressed so it can stop being true.
     *
     * An equality, not two inclusions, because the two directions catch
     * different mistakes and both matter: an index in the catalogue and not here
     * is one nobody decided about — the exact state the audit found and resolved
     * — and one here but not in the catalogue is a migration that took a live
     * index with it. A `toContain` loop would pass in the first case, which is
     * the case the audit exists to prevent recurring.
     */
    const catalogued = await catalogueIndexNames('posts');
    const classified = POSTS_INDEXES.map((index) => index.name).sort();

    expect(
      catalogued.length,
      'no indexes read back for `posts` — the catalogue query is broken',
    ).toBeGreaterThanOrEqual(20);
    expect(
      catalogued,
      'An index on `posts` is unclassified, or one classified here is gone.\n' +
        'Add it to POSTS_INDEXES with its exact `pg_indexes.indexdef` and what pays when it is missing — ' +
        'or, if a migration removed it, delete its entry in the SAME change.\n' +
        'Do NOT relax this to a subset check: an index nobody decided about is what the #753 audit found.',
    ).toEqual(classified);
  });

  it('names each index exactly once', () => {
    // A duplicate entry would make the equality above pass while the count of
    // distinct classifications silently disagreed with the list's length.
    const names = ALL_INDEXES.map((index) => index.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

it('bounds source index creation, restores prior timeouts and serves exact actor lookups', async () => {
  const migration = readFileSync(
    path.resolve(__dirname, '../../../drizzle/0039_source_identity_projection_index.sql'),
    'utf8',
  );
  await db.transaction(async (tx) => {
    // A private table shadows public.posts only on this transaction's connection.
    await tx.execute(
      sql`create temp table posts (federation_actor_uri text, oxy_user_id text) on commit drop`,
    );
    await tx.execute(
      sql`insert into posts select case when n % 4 = 0 then null else 'https://fixture.invalid/' || (n % 200)::text end, 'old' from generate_series(1, 2000) n`,
    );
    await tx.execute(sql`set local lock_timeout = '750ms'`);
    await tx.execute(sql`set local statement_timeout = '90s'`);
    let boundedBuildObserved = false;
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trimStart().startsWith('CREATE INDEX')) {
        const [settings] = await tx.execute<{ lock_timeout: string; statement_timeout: string }>(
          sql`select current_setting('lock_timeout') lock_timeout, current_setting('statement_timeout') statement_timeout`,
        );
        expect(settings).toEqual({ lock_timeout: '5s', statement_timeout: '1min' });
        boundedBuildObserved = true;
      }
      await tx.execute(sql.raw(statement));
    }
    expect(boundedBuildObserved).toBe(true);
    const [restored] = await tx.execute<{ lock_timeout: string; statement_timeout: string }>(
      sql`select current_setting('lock_timeout') lock_timeout, current_setting('statement_timeout') statement_timeout`,
    );
    expect(restored).toEqual({ lock_timeout: '750ms', statement_timeout: '90s' });
    await tx.execute(sql`analyze posts`);
    const rows = await tx.execute<{ 'QUERY PLAN': string }>(
      sql`explain (costs off) select distinct oxy_user_id from posts where federation_actor_uri = 'https://fixture.invalid/101'`,
    );
    expect(rows.map((row) => row['QUERY PLAN']).join('\n')).toContain(
      'posts_federation_actor_uri_idx',
    );
  });
});

it('replaces the source index with one keyed by author, building before it drops', async () => {
  const read = (file: string) =>
    readFileSync(path.resolve(__dirname, `../../../drizzle/${file}`), 'utf8');
  const before = read('0039_source_identity_projection_index.sql');
  const migration = read('0069_posts_federation_actor_author_idx.sql');
  await db.transaction(async (tx) => {
    // A private table shadows public.posts only on this transaction's connection.
    await tx.execute(
      sql`create temp table posts (federation_actor_uri text, oxy_user_id text) on commit drop`,
    );
    await tx.execute(
      sql`insert into posts select case when n % 4 = 0 then null else 'https://fixture.invalid/' || (n % 200)::text end, 'current' from generate_series(1, 2000) n`,
    );
    for (const statement of before.split('--> statement-breakpoint')) {
      await tx.execute(sql.raw(statement));
    }
    await tx.execute(sql`set local lock_timeout = '750ms'`);
    await tx.execute(sql`set local statement_timeout = '90s'`);
    const order: string[] = [];
    for (const statement of migration.split('--> statement-breakpoint')) {
      const ddl = /^\s*(?:--.*\n)*\s*(CREATE INDEX|DROP INDEX)/.exec(statement)?.[1];
      if (ddl) {
        const [settings] = await tx.execute<{ lock_timeout: string; statement_timeout: string }>(
          sql`select current_setting('lock_timeout') lock_timeout, current_setting('statement_timeout') statement_timeout`,
        );
        expect(settings).toEqual({ lock_timeout: '5s', statement_timeout: '1min' });
        order.push(ddl);
      }
      await tx.execute(sql.raw(statement));
    }
    // DROP INDEX holds ACCESS EXCLUSIVE on posts until commit; built first, the
    // new index is never absent and reads are never blocked for the build.
    expect(order).toEqual(['CREATE INDEX', 'DROP INDEX']);
    const [restored] = await tx.execute<{ lock_timeout: string; statement_timeout: string }>(
      sql`select current_setting('lock_timeout') lock_timeout, current_setting('statement_timeout') statement_timeout`,
    );
    expect(restored).toEqual({ lock_timeout: '750ms', statement_timeout: '90s' });

    const indexes = await tx.execute<{ indexname: string }>(
      sql`select indexname from pg_indexes where tablename = 'posts' and schemaname like 'pg_temp%' order by 1`,
    );
    expect(indexes.map((row) => row.indexname)).toEqual(['posts_federation_actor_author_idx']);

    await tx.execute(sql`analyze posts`);
    const rows = await tx.execute<{ 'QUERY PLAN': string }>(
      sql`explain (costs off) select distinct oxy_user_id from posts where federation_actor_uri = 'https://fixture.invalid/101' and oxy_user_id is distinct from 'current'`,
    );
    expect(rows.map((row) => row['QUERY PLAN']).join('\n')).toContain(
      'posts_federation_actor_author_idx',
    );
  });
});

it('bounds the federation URL index build, restores prior timeouts and serves exact URL lookups', async () => {
  const migration = readFileSync(
    path.resolve(__dirname, '../../../drizzle/0046_posts_federation_url_idx.sql'),
    'utf8',
  );
  await db.transaction(async (tx) => {
    // A private table shadows public.posts only on this transaction's connection.
    await tx.execute(
      sql`create temp table posts (id text, federation_url text, status text, visibility text) on commit drop`,
    );
    await tx.execute(
      sql`insert into posts select n::text, case when n % 4 = 0 then null else 'https://www.threads.com/@fixture/post/' || n::text end, 'published', 'public' from generate_series(1, 2000) n`,
    );
    await tx.execute(sql`set local lock_timeout = '750ms'`);
    await tx.execute(sql`set local statement_timeout = '90s'`);
    let boundedBuildObserved = false;
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trimStart().startsWith('CREATE INDEX')) {
        const [settings] = await tx.execute<{ lock_timeout: string; statement_timeout: string }>(
          sql`select current_setting('lock_timeout') lock_timeout, current_setting('statement_timeout') statement_timeout`,
        );
        expect(settings).toEqual({ lock_timeout: '5s', statement_timeout: '1min' });
        boundedBuildObserved = true;
      }
      await tx.execute(sql.raw(statement));
    }
    expect(boundedBuildObserved).toBe(true);
    const [restored] = await tx.execute<{ lock_timeout: string; statement_timeout: string }>(
      sql`select current_setting('lock_timeout') lock_timeout, current_setting('statement_timeout') statement_timeout`,
    );
    expect(restored).toEqual({ lock_timeout: '750ms', statement_timeout: '90s' });
    await tx.execute(sql`analyze posts`);
    // The shape `resolvePostIdFromNoteUrl` issues.
    const rows = await tx.execute<{ 'QUERY PLAN': string }>(
      sql`explain (costs off) select id from posts where federation_url = 'https://www.threads.com/@fixture/post/101' and status = 'published' and visibility = 'public' limit 1`,
    );
    expect(rows.map((row) => row['QUERY PLAN']).join('\n')).toContain('posts_federation_url_idx');
  });
});

it('bounds the public-author window index build, restores prior timeouts and serves the snapshot sweep (#1166)', async () => {
  const migration = readFileSync(
    path.resolve(__dirname, '../../../drizzle/0052_posts_public_author_recent_idx.sql'),
    'utf8',
  );
  await db.transaction(async (tx) => {
    // A private table shadows public.posts only on this transaction's connection.
    await tx.execute(
      sql`create temp table posts (id text, oxy_user_id text, created_at timestamptz, status text, visibility text) on commit drop`,
    );
    await tx.execute(
      sql`insert into posts select n::text, 'author-' || (n % 500)::text, now() - (n || ' minutes')::interval, case when n % 10 = 0 then 'draft' else 'published' end, case when n % 7 = 0 then 'private' else 'public' end from generate_series(1, 200000) n`,
    );
    await tx.execute(sql`set local lock_timeout = '750ms'`);
    await tx.execute(sql`set local statement_timeout = '90s'`);
    let boundedBuildObserved = false;
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (/^CREATE INDEX/m.test(statement)) {
        const [settings] = await tx.execute<{ lock_timeout: string; statement_timeout: string }>(
          sql`select current_setting('lock_timeout') lock_timeout, current_setting('statement_timeout') statement_timeout`,
        );
        expect(settings).toEqual({ lock_timeout: '5s', statement_timeout: '1min' });
        boundedBuildObserved = true;
      }
      await tx.execute(sql.raw(statement));
    }
    expect(boundedBuildObserved).toBe(true);
    const [restored] = await tx.execute<{ lock_timeout: string; statement_timeout: string }>(
      sql`select current_setting('lock_timeout') lock_timeout, current_setting('statement_timeout') statement_timeout`,
    );
    expect(restored).toEqual({ lock_timeout: '750ms', statement_timeout: '90s' });
    await tx.execute(sql`analyze posts`);
    // The distinct-author window the sweep reads (fourteen days of 200k rows is
    // about 10% of them, the production proportion).
    const rows = await tx.execute<{ 'QUERY PLAN': string }>(
      sql`explain (costs off) select distinct oxy_user_id from posts where created_at >= now() - interval '20000 minutes' and visibility = 'public' and status = 'published' and oxy_user_id is not null`,
    );
    expect(rows.map((row) => row['QUERY PLAN']).join('\n')).toContain(
      'posts_public_author_recent_idx',
    );
  });
});

it('drops the four unread posts indexes under a bounded lock wait and restores prior timeouts', async () => {
  const migration = readFileSync(
    path.resolve(__dirname, '../../../drizzle/0073_posts_unused_indexes.sql'),
    'utf8',
  );
  const dropped = [
    'post_links_chrono_v1',
    'posts_type_chrono_idx',
    'posts_public_topic_recent_idx',
    'posts_classification_queue_idx',
  ];
  await db.transaction(async (tx) => {
    // A private table shadows public.posts only on this transaction's connection,
    // and the temp schema is searched first, so the drops resolve to its indexes.
    await tx.execute(sql`create temp table posts (id text, created_at timestamptz) on commit drop`);
    for (const name of dropped) {
      await tx.execute(sql.raw(`create index "${name}" on posts (created_at)`));
    }
    await tx.execute(sql`create index posts_kept_idx on posts (id)`);
    await tx.execute(sql`set local lock_timeout = '750ms'`);
    await tx.execute(sql`set local statement_timeout = '90s'`);
    const drops: string[] = [];
    for (const statement of migration.split('--> statement-breakpoint')) {
      const name = /^DROP INDEX IF EXISTS "(\w+)"/m.exec(statement)?.[1];
      if (name) {
        const [settings] = await tx.execute<{ lock_timeout: string; statement_timeout: string }>(
          sql`select current_setting('lock_timeout') lock_timeout, current_setting('statement_timeout') statement_timeout`,
        );
        expect(settings).toEqual({ lock_timeout: '5s', statement_timeout: '1min' });
        drops.push(name);
      }
      await tx.execute(sql.raw(statement));
    }
    expect(drops).toEqual(dropped);
    const [restored] = await tx.execute<{ lock_timeout: string; statement_timeout: string }>(
      sql`select current_setting('lock_timeout') lock_timeout, current_setting('statement_timeout') statement_timeout`,
    );
    expect(restored).toEqual({ lock_timeout: '750ms', statement_timeout: '90s' });

    const indexes = await tx.execute<{ indexname: string }>(
      sql`select indexname from pg_indexes where tablename = 'posts' and schemaname like 'pg_temp%' order by 1`,
    );
    expect(indexes.map((row) => row.indexname)).toEqual(['posts_kept_idx']);
  });
});
