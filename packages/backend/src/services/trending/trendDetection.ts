/**
 * Trend DETECTION — the aggregation that measures every candidate term over the
 * trailing window, and the co-occurrence pass that merges the ones telling one
 * story.
 *
 * Everything here answers a single question: what is the network saying, and
 * how widely. Ranking, labelling, persistence and presentation all read the
 * measurements this module produces, and none of them can change what was
 * counted — which is the property that makes a floor or a ceiling mean the same
 * thing wherever it is applied.
 */

import { and, eq, gte, sql, type SQL } from 'drizzle-orm';
import { MtnConfig, PostVisibility } from '@mention/shared-types';
import { getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { logger } from '../../utils/logger';
import { isNsfwHashtag } from '../contentClassification/nsfw';
import { isTopicSlug } from '../contentClassification/taxonomy';
import { isTrendStopWord } from './termExtraction';
import { trendCandidateUnionSql } from './termSpace';
import {
  buildClusterMap,
  clusterTrendTerms,
  type TrendTermPair,
} from './trendClustering';
import {
  buildTrendGraph,
  type TrendGraphNodeInput,
  type TrendGraphSnapshot,
} from './trendGraph';
// Trending shares the SINGLE canonical sensitive-exclusion clause with every
// feed (For You, Explore, ranking). Adding a new gate updates trending too.
import { sensitiveExcludeSql } from '../../mtn/feed/feedSafety';
import type { TrendCandidate } from './trendScoring';

/**
 * One term as the aggregation measured it: the numbers the scorer needs, plus
 * the two facts only the aggregation can know — who posted it, and whether the
 * term arrived mostly as a hashtag (which is all `type` means now).
 */
export interface TermCandidate {
  measurement: TrendCandidate;
  actorIds: string[];
  /** Posts on which the term appeared as a hashtag. Decides `type`, never the score. */
  hashtagVolume: number;
  /**
   * Posts on which the term appeared as a CLASSIFIED topic slug. Gates the topic
   * registry lookup: only a term the classifier itself produced may be resolved
   * there, because `resolveNames` writes through to the shared registry.
   */
  topicVolume: number;
  /** Primary languages of the posts behind the term (ISO 639-1). */
  languages: string[];
  /** Coarse regions of those posts, where known. Frequently empty — the field is sparse. */
  regions: string[];
  /**
   * Every term this row reports, the representative first.
   *
   * One element for a term that stands alone; several when co-occurrence
   * showed `Ukraine`, `Kyiv` and `Zelensky` to be one story. Persisted, because
   * the row's feed has to match all of them: opening `Ukraine` onto posts that
   * only ever said `Kyiv` is the whole point of having merged them.
   */
  members: string[];
}

/** What one aggregation pass produces: the rows to rank, and the graph behind them. */
export interface TermCandidateResult {
  candidates: TermCandidate[];
  /** `null` when clustering is disabled — no co-occurrence query ran, so there are no edges. */
  graph: TrendGraphSnapshot | null;
}

/** The four fields the graph needs out of a per-term measurement. */
function graphNodes(candidates: readonly TermCandidate[]): TrendGraphNodeInput[] {
  return candidates.map((candidate) => ({
    term: candidate.measurement.term,
    volume: candidate.measurement.volume,
    authorCount: candidate.measurement.authorCount,
    languages: candidate.languages,
    regions: candidate.regions,
  }));
}

/**
 * The corpus a term could plausibly have appeared in.
 *
 * The sum of the corpora of the languages it WAS written in — not the whole
 * window. A term seen only in Spanish posts is measured against Spanish, so its
 * share means the same thing whether Spanish is most of this network or a
 * tenth of it. That invariance is the entire point: without it the ceiling is
 * strict for the majority language and nearly inert for every other one.
 *
 * A term whose posts carry no resolved language falls back to the whole window,
 * which is the honest denominator when the language is unknown.
 */
function corpusSizeFor(
  languages: readonly string[],
  corpusByLanguage: ReadonlyMap<string | null, number>,
): number {
  let total = 0;
  for (const count of corpusByLanguage.values()) total += count;
  if (languages.length === 0) return total;

  let scoped = 0;
  for (const language of languages) scoped += corpusByLanguage.get(language) ?? 0;
  // A language the corpus count never saw leaves `scoped` at 0; the window
  // total is a safer denominator than dividing by nothing.
  return scoped > 0 ? scoped : total;
}

/**
 * Measure every candidate term over the trailing window, in ONE pipeline.
 *
 * ## One term space
 *
 * A term is drawn from the union of three fields on the post:
 * `postClassification.trendTerms` (the words the post's own text is about),
 * the canonical `hashtags`, and `postClassification.topics`. They are UNIONED
 * rather than counted in separate lanes because they are three ways of
 * learning the same fact — that this post is about `fifa` — and the previous
 * design's separate hashtag and topic lanes are precisely why the list read as
 * a hashtag ranking: the lane that was cheapest to fill decided the output.
 *
 * The union also makes the corpus work TODAY rather than after a backfill: a
 * post written before term extraction has no `trendTerms`, and still
 * contributes through its hashtags and classified topics.
 *
 * ## What is counted
 *
 * `volume` and `recentVolume` are post counts; `authorCount` is DISTINCT
 * authors, which is the number the reporting floor is applied to. Counting
 * posts alone cannot tell fifty people agreeing from one account posting fifty
 * times, and those are opposite facts.
 *
 * `hashtagVolume` / `topicVolume` are provenance, not ranking: they only
 * decide the row's `type` (and which terms may be looked up in the topic
 * registry). Nothing about the score depends on how the term was written.
 */
export async function aggregateTermCandidates(now: Date): Promise<TermCandidateResult> {
  const { windowMs, recentWindowMs } = MtnConfig.trending.detection;
  const windowStart = new Date(now.getTime() - windowMs);
  const recentStart = new Date(now.getTime() - recentWindowMs);

  // The window predicate, built ONCE and used by the corpus count, both term
  // aggregation passes and the co-occurrence query. A term's SHARE of the
  // corpus is only meaningful if the two were counted the same way — a ratio
  // against a corpus the term was never drawn from measures nothing, and one
  // value passed around is what stops two spellings of "the same match"
  // drifting apart.
  //
  // The spam clause is `is not true`, not `< threshold`. Mongo's
  // `{ $not: { $gte: n } }` MATCHED a post with no spam score at all (an
  // unclassified post), and SQL's `<` would DROP exactly those rows, silently
  // shrinking both the corpus and every term's count. `is not true` is total:
  // NULL and false both pass, which is the Mongo behaviour.
  const windowMatch = and(
    gte(posts.createdAt, windowStart),
    eq(posts.status, 'published'),
    eq(posts.visibility, PostVisibility.PUBLIC),
    // Boosts are an intentionally-empty mirror shape; the original is what
    // carries the terms, and counting both would double one post.
    sql`${posts.boostOf} is null`,
    sensitiveExcludeSql(),
    // The SAME threshold the discovery gate uses — one authority for "this is
    // junk in discovery", rather than a second number here that could drift.
    //
    // Worth being precise about what this does and does not buy: it catches
    // RSS/bridge mirrors and link-only news bots, which is a real class. It did
    // NOT catch the account that topped this instance's list — a
    // `mastodon.social` Person posting real prose with eleven boilerplate
    // hashtags, which scores nowhere near spam. The guard that catches THAT is
    // the concentration ceiling in `clearsFloors`. This clause is the cheap
    // complement, not the fix.
    sql`(${posts.classificationScoreSpam} >= ${MtnConfig.feed.discoveryGate.spamRejectThreshold}) is not true`,
  ) as SQL;

  // Corpus size PER LANGUAGE, not just in total. The share-of-corpus ceiling
  // is only meaningful against the corpus a term could have appeared in: a
  // Spanish function word is common among Spanish posts and rare against a
  // corpus dominated by another language, so a global denominator makes the
  // guard systematically weaker for every minority language — exactly where a
  // hand-written stop-word list is already weakest.
  const corpusByLanguage = await countWindowPostsByLanguage(windowMatch);

  // Pass one: every term the authors themselves wrote, counted alone.
  const solo = await aggregateTermRows(
    windowMatch,
    recentStart,
    corpusByLanguage,
    trendCandidateUnionSql(),
    new Map(),
  );

  const clustering = MtnConfig.trending.clustering;
  // No graph when clustering is off: the co-occurrence query is the only
  // thing that produces edges, and running it to serve a picture nothing else
  // uses would be paying for a feature that is switched off.
  if (!clustering.enabled || solo.length === 0) return { candidates: solo, graph: null };

  // Pass two, only when co-occurrence actually found a story spread across
  // several names. Re-counting rather than adding the members' volumes up is
  // the whole reason this is a second query: a post saying both `Ukraine` and
  // `Kyiv` is ONE post, and a sum would report it as two — inflating the very
  // number the reporting floors are applied to.
  const pairs = await loadTermPairs(
    windowMatch,
    solo.map((candidate) => candidate.measurement.term),
  );
  const { clusters, linkedPairs, refusedForSize } = clusterTrendTerms(
    solo.map((candidate) => ({
      term: candidate.measurement.term,
      volume: candidate.measurement.volume,
    })),
    pairs,
    clustering,
  );
  if (refusedForSize.length > 0) {
    // A refused merge leaves a story split across rows, which on the screen is
    // indistinguishable from clustering never having run. Said out loud, a
    // ceiling that is too tight is visible as itself.
    logger.info('[Trending] Cluster merges declined for size', {
      count: refusedForSize.length,
      pairs: refusedForSize.slice(0, 10),
    });
  }
  if (clusters.length === 0) {
    // Edges but no stories is a real and informative state — it says the
    // network is talking about several separate things — so the graph is
    // still worth keeping.
    return { candidates: solo, graph: buildTrendGraph(now, graphNodes(solo), pairs, [], new Map()) };
  }

  const aliases = buildClusterMap(clusters);
  const membersOf = new Map(clusters.map((cluster) => [cluster.representative, cluster.members]));
  logger.info('[Trending] Merged co-occurring terms into stories', {
    clusters: clusters.length,
    merged: aliases.size,
  });

  const merged = await aggregateTermRows(
    windowMatch,
    recentStart,
    corpusByLanguage,
    clusteredTermsSql(aliases),
    membersOf,
  );
  // A cluster whose representative failed the floors it passed alone would
  // take its members down with it, so a merge can never LOSE a row: anything
  // pass two dropped is restored from pass one.
  const survived = new Set(merged.map((candidate) => candidate.measurement.term));
  const orphaned = solo.filter(
    (candidate) =>
      !survived.has(candidate.measurement.term) && !aliases.has(candidate.measurement.term),
  );
  return {
    candidates: [...merged, ...orphaned],
    // Built from the SOLO measurements, not the merged ones: an edge's two
    // ratios are `posts` over each endpoint's OWN volume, and a merged row
    // reports the story's volume instead. Reading a cluster total as a term
    // total is how a graph ends up drawing links that do not follow from its
    // own numbers.
    graph: buildTrendGraph(now, graphNodes(solo), pairs, linkedPairs, aliases),
  };
}

/**
 * One counting pass over the window, grouped by whatever `termsSql` says a
 * post's terms are.
 *
 * Shared by both passes so clustering cannot introduce a second, subtly
 * different definition of volume, recency, authorship or language — the
 * numbers the floors and the burst statistic are applied to. The only thing
 * that differs between the two calls is what a term IS.
 *
 * `lateral unnest` is Mongo's `$unwind` over the term expression, and the
 * `group by` is its `$group`. `array_agg(distinct …)` gives the
 * distinct-author set; the `count(*) filter` clauses are its `$cond` sums.
 *
 * NULL authors, languages and regions are excluded INSIDE the aggregates
 * rather than by a WHERE clause, because a legacy orphan federated post is a
 * real post that must still count toward `volume` — it simply cannot testify
 * to WHO is posting, and letting it inflate the distinct-author floor would be
 * the one way to walk straight past that floor.
 */
async function aggregateTermRows(
  windowMatch: SQL,
  recentStart: Date,
  corpusByLanguage: Map<string | null, number>,
  termsSql: SQL,
  membersOf: ReadonlyMap<string, string[]>,
): Promise<TermCandidate[]> {
  const { minVolume, maxActors, authorPostCap } = MtnConfig.trending.detection;

  // TWO grouping levels, because volume is per-AUTHOR-capped: a term's volume
  // is assembled from what each author contributed, not from a flat post
  // count. `expanded` is the shared scan both levels read, so the corpus is
  // walked ONCE rather than once per level.
  const rows = await getDb().execute<{
    term: string;
    volume: number;
    recentVolume: number;
    hashtagVolume: number;
    topicVolume: number;
    authorCount: number;
    actorIds: string[] | null;
    languages: string[] | null;
    regions: string[] | null;
  }>(sql`
    with expanded as (
      select
        trend_term.term as term,
        ${posts.oxyUserId} as author,
        ${posts.createdAt} as created_at,
        ${posts.language} as language,
        ${posts.classificationRegion} as region,
        ${posts.hashtags} as hashtags,
        ${posts.classificationTopics} as topics
      from ${posts}
      -- select distinct inside the lateral, not a bare unnest.
      --
      -- The union is a CONCATENATION of arrays, so a post carrying the term
      -- BOTH as a hashtag and as an extracted term unnests twice and is
      -- counted twice — inflating that term's volume, its author set and its
      -- burst score against every term that appears once per post. What a
      -- reader would have seen is a term trending because one post mentioned
      -- it twice. Mongo's $setUnion deduplicated per document and this is
      -- where that property lives now. It is what makes the CLUSTERED
      -- expression safe too: mapping Kyiv onto Ukraine yields the
      -- representative twice for a post that said both, and that one post
      -- must count once against the story.
      join lateral (select distinct unnest(${termsSql}) as term) as trend_term on true
      -- The SAME predicate value the corpus count used, not a copy of it: the
      -- share-of-corpus ratio is only meaningful when numerator and
      -- denominator are drawn from one population, and two spellings of "the
      -- same match" is how they stop being.
      where ${windowMatch}
    ),
    per_author as (
      select
        term,
        author,
        count(*) as posts,
        -- The instant is passed as an ISO string with an explicit cast, not
        -- as a JS Date. db.execute hands a raw template parameter straight
        -- to postgres.js without the column type drizzle's own builder
        -- attaches, and a Date there throws ERR_INVALID_ARG_TYPE at
        -- serialization rather than failing as SQL.
        count(*) filter (where created_at >= ${recentStart.toISOString()}::timestamptz) as recent_posts
      from expanded
      group by term, author
    ),
    capped as (
      select
        term,
        -- Each author counted at most authorPostCap times, so volume
        -- measures how WIDELY a term is being said rather than how much. The
        -- bot that posts twenty contributes two, and the volume floor then
        -- measures breadth without anything having to be identified as a bot.
        sum(least(posts, ${authorPostCap}))::int as volume,
        sum(least(recent_posts, ${authorPostCap}))::int as recent_volume
      from per_author
      group by term
    )
    select
      e.term as "term",
      c.volume as "volume",
      c.recent_volume as "recentVolume",
      -- Provenance is NOT capped: it only decides the row's type, and the
      -- question there is how the term was written, not by how many.
      (count(*) filter (where e.hashtags @> array[e.term]::text[]))::int as "hashtagVolume",
      (count(*) filter (where e.topics @> array[e.term]::text[]))::int as "topicVolume",
      (count(distinct e.author))::int as "authorCount",
      (array_agg(distinct e.author) filter (where e.author is not null))[1:${sql.raw(String(maxActors))}] as "actorIds",
      coalesce(array_agg(distinct e.language) filter (where e.language is not null), array[]::text[]) as "languages",
      coalesce(array_agg(distinct e.region) filter (where e.region is not null), array[]::text[]) as "regions"
    from expanded e
    join capped c on c.term = e.term
    group by e.term, c.volume, c.recent_volume
    -- Cheapest possible narrowing, against the CAPPED volume — the number the
    -- floor is meant to be about.
    having c.volume >= ${minVolume}
  `);

  return rows
    // Blocklisted NSFW/adult terms never trend, whatever their numbers.
    .filter((row) => !isNsfwHashtag(row.term))
    // Stop words are filtered AGAIN here, not only at extraction.
    //
    // Extraction runs once, when a post arrives, so a term stored before a
    // word joined the list keeps counting for as long as the window holds it
    // — `why` and `will` stayed on the live list after the change that was
    // supposed to remove them, and would have kept their place for a day.
    // Filtering at detection makes the list retroactive the moment the batch
    // runs, and makes it impossible for the version of the word list that
    // happened to be deployed when a post arrived to decide what trends now.
    // The extraction-time filter still earns its place: it keeps the stored
    // arrays and their index small. This is the one that decides.
    .filter((row) => !isTrendStopWord(row.term))
    // A term that IS one of our own category names is a shelf label, not a
    // thing on the shelf. `classification_topics` stopped proposing
    // candidates for exactly this reason, but the same words also arrive as
    // hashtags an author typed — `#news` reached the live list with fifteen
    // authors and named a row "News · News" — so the rule belongs on the term
    // itself rather than on one of the fields it can travel in.
    //
    // Not a word list: it is the taxonomy already maintained for labelling,
    // read as a stop-list for candidacy. A category gained or renamed there
    // changes this with it.
    .filter((row) => !isTopicSlug(row.term))
    .map((row) => {
      const languages = row.languages ?? [];
      const corpus = corpusSizeFor(languages, corpusByLanguage);
      return {
        measurement: {
          term: row.term,
          volume: row.volume,
          recentVolume: row.recentVolume,
          authorCount: row.authorCount,
          // Set only when the corpus size is known. Absent means "not
          // measured", which the ceiling treats as passing — losing the guard
          // is the right cost of a failed count, losing the term is not.
          ...(corpus ? { documentFrequency: row.volume / corpus } : {}),
        },
        actorIds: row.actorIds ?? [],
        hashtagVolume: row.hashtagVolume,
        topicVolume: row.topicVolume,
        languages,
        regions: row.regions ?? [],
        // A term that was never merged reports itself, so every downstream
        // reader can treat `members` as the row's term list without first
        // asking whether clustering ran.
        members: membersOf.get(row.term) ?? [row.term],
      };
    });
}

/**
 * The candidate terms of a post with every clustered member rewritten to the
 * term its row is reported under.
 *
 * A `CASE` per merged member, applied to each element of the candidate union.
 * Mongo needed a `$setUnion` around the mapped array so that a post saying
 * both `Ukraine` and `Kyiv` did not yield the representative twice and get
 * counted twice against the story; here the `select distinct` inside
 * `aggregateTermRows`'s lateral already carries that property, for this
 * expression and the unmapped one alike — one place, not two.
 *
 * Built with `sql.join` over bound parameters rather than interpolated text:
 * a term is arbitrary user-written content and reaches this function straight
 * from a post's own extracted vocabulary.
 */
function clusteredTermsSql(aliases: ReadonlyMap<string, string>): SQL {
  const merged = [...aliases.entries()].filter(
    ([member, representative]) => member !== representative,
  );
  if (merged.length === 0) return trendCandidateUnionSql();

  const branches = sql.join(
    merged.map(([member, representative]) => sql`when ${member} then ${representative}`),
    sql` `,
  );
  // `array(select …)` rather than `coalesce(array_agg(…), …)`: it yields an
  // empty array for a post with no candidate terms instead of NULL, which is
  // what the caller's `unnest` needs to produce no rows rather than one.
  return sql`array(
    select case t.term ${branches} else t.term end
    from unnest(${trendCandidateUnionSql()}) as t(term)
  )`;
}

/**
 * How many posts each PAIR of candidate terms appears in together.
 *
 * Restricted to terms that already cleared the volume floor, which is what
 * keeps this cheap: the pair count is quadratic in the terms one post carries,
 * and a post carries very few candidate terms once ordinary vocabulary is out
 * of the space. `minPairPosts` is applied here rather than in memory so the
 * long tail of pairs that met once never leaves the database.
 *
 * Fail-soft: without pairs nothing merges and every term reports alone, which
 * is exactly the behaviour before clustering existed.
 */
async function loadTermPairs(
  windowMatch: SQL,
  terms: readonly string[],
): Promise<TrendTermPair[]> {
  if (terms.length < 2) return [];

  try {
    // The post's candidate terms INTERSECTED with the ones that cleared the
    // floor, deduplicated — `select distinct`, for the same reason
    // `aggregateTermRows` needs it: the union is a concatenation, so a term
    // carried both as a hashtag and as an extracted term would appear twice
    // and pair with itself through the self-join.
    // Each term its OWN bound parameter. A JS array interpolated into a `sql`
    // template expands to a row constructor rather than binding as an array
    // (see `trendTermMatchSql`), and a term is arbitrary author-written text,
    // so neither a raw array cast nor string interpolation is available here.
    const floorTerms = sql.join(
      terms.map((term) => sql`${term}`),
      sql`, `,
    );
    const postTerms = (alias: string): SQL => sql`lateral (
      select distinct t.term
      from unnest(${trendCandidateUnionSql()}) as t(term)
      where t.term in (${floorTerms})
    ) as ${sql.raw(alias)}`;

    const rows = await getDb()
      .select({
        a: sql<string>`pair_a.term`,
        b: sql<string>`pair_b.term`,
        posts: sql`count(*)`.mapWith(Number),
      })
      .from(posts)
      // Self-join over the SAME per-post term set, one side renamed. `<` gives
      // each unordered pair exactly once and can never pair a term with
      // itself, which is what Mongo's `$expr: { $lt: … }` after the double
      // `$unwind` did. A post carrying fewer than two of the terms produces no
      // row at all, so there is nothing to pre-filter.
      .innerJoin(postTerms('pair_a'), sql`true`)
      .innerJoin(postTerms('pair_b'), sql`pair_b.term > pair_a.term`)
      .where(windowMatch)
      .groupBy(sql`pair_a.term, pair_b.term`)
      // Applied here rather than in memory so the long tail of pairs that met
      // once never leaves the database.
      .having(sql`count(*) >= ${MtnConfig.trending.clustering.minPairPosts}`);

    return rows.map((row) => ({ a: row.a, b: row.b, posts: row.posts }));
  } catch (error) {
    logger.warn('[Trending] Co-occurrence lookup failed; terms report individually', { error });
    return [];
  }
}

/**
 * How many posts the window held — the denominator of a term's share of the
 * corpus.
 *
 * Fail-soft to `null`: without it every candidate simply skips the vocabulary
 * ceiling, which is a weaker list for one batch. Throwing instead would trade
 * the whole batch for one guard.
 */
async function countWindowPostsByLanguage(
  windowMatch: SQL,
): Promise<Map<string | null, number>> {
  const byLanguage = new Map<string | null, number>();
  try {
    const rows = await getDb()
      .select({
        language: posts.language,
        count: sql`count(*)`.mapWith(Number),
      })
      .from(posts)
      .where(windowMatch)
      .groupBy(posts.language);
    for (const row of rows) byLanguage.set(row.language, row.count);
  } catch (error) {
    logger.warn('[Trending] Corpus size lookup failed; vocabulary ceiling skipped', { error });
  }
  return byLanguage;
}
