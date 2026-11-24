/**
 * Trend DETECTION — the aggregation that measures every candidate term over the
 * trailing window, and the two passes that merge the ones telling one story:
 * co-occurrence (names written in the same posts) and synchrony (names that rise
 * together without being).
 *
 * Everything here answers a single question: what is the network saying, and
 * how widely. Ranking, labelling, persistence and presentation all read the
 * measurements this module produces, and none of them can change what was
 * counted — which is the property that makes a floor or a ceiling mean the same
 * thing wherever it is applied.
 */

import { and, eq, gte, sql, type SQL } from 'drizzle-orm';
import { MtnConfig, PostVisibility } from '@mention/shared-types';
import { config } from '../../config';
import type { Transaction } from '../../db/postgres';
import { withStatementTimeout } from '../../utils/withStatementTimeout';
import { posts } from '../../db/schema/posts';
import { logger } from '../../utils/logger';
import { notCollapsedCrosspostSql } from '../../utils/feedQueryBuilder';
import { isNsfwHashtag } from '../contentClassification/nsfw';
import { isTopicSlug } from '../contentClassification/taxonomy';
import { isTrendStopWord } from './termExtraction';
import { pickLabelTerm } from './trendLabeling';
import { trendCandidateUnionSql } from './termSpace';
import { buildClusterMap, clusterTrendTerms, type TrendTermPair } from './trendClustering';
import { mergeSynchronizedTerms, peakShare } from './trendSynchrony';
import { buildTrendGraph, type TrendGraphNodeInput, type TrendGraphSnapshot } from './trendGraph';
// Trending shares the SINGLE canonical sensitive-exclusion clause with every
// feed (For You, Explore, ranking). Adding a new gate updates trending too.
import { sensitiveExcludeSql } from '../../mtn/feed/feedSafety';
import { openAudienceAuthorSql } from '../../db/userProfile/profileAudience';
import type { TrendCandidate } from './trendScoring';
import { resolveTrendConcept } from './conceptRegistry';

/**
 * Run one window scan under the BACKGROUND statement budget.
 *
 * The serving pool caps every statement at 15 s so no request can hold a
 * connection behind a runaway query. A trend batch is not a request: it reads
 * two days of `posts`, and when the pages are cold that scan passes 15 s (31 s
 * measured, production, 2026-11-24) and the whole batch fails — the list then
 * serves a stale batch. Each scan gets its own transaction rather than one for
 * the batch, so a scan that fails still fails alone and the fail-soft ones
 * (`loadTermPairs`, the corpus count) keep their meaning.
 */
const scan = <T>(work: (db: Transaction) => Promise<T>): Promise<T> =>
  withStatementTimeout(config.postgres.backgroundStatementTimeoutMs, work);

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
  /** The member the row's NAME is derived from, when it is not the representative. */
  labelTerm?: string;
  /** Language-independent identity, only when a reviewed alias resolved it. */
  conceptId?: string;
}

/**
 * The window a measurement was taken over: the predicate, the recent-window
 * start and the per-language corpus size. Carried so a later re-measurement
 * counts the same posts the same way rather than inventing a second definition.
 */
export interface TrendWindow {
  windowMatch: SQL;
  recentStart: Date;
  corpusByLanguage: Map<string | null, number>;
}

/** What one aggregation pass produces: the rows to rank, the graph behind them, and the window they were counted over. */
export interface TermCandidateResult {
  candidates: TermCandidate[];
  /** `null` when clustering is disabled — no co-occurrence query ran, so there are no edges. */
  graph: TrendGraphSnapshot | null;
  window: TrendWindow;
}

/**
 * Re-measure groups of terms as single stories, through the SAME counting pass
 * the batch uses.
 *
 * Each group is `[representative, ...members]`. Volume and authors are distinct
 * counts over the union of posts, so the result is never a sum of the members'
 * numbers — a post carrying two of them counts once.
 *
 * Returns the measurement for each representative that the floors admit, keyed
 * by representative. A representative the floors reject is absent.
 */
export async function remeasureTermGroups(
  window: TrendWindow,
  groups: readonly (readonly string[])[],
): Promise<Map<string, TermCandidate>> {
  const measured = new Map<string, TermCandidate>();
  if (groups.length === 0) return measured;

  const aliases = new Map<string, string>();
  const membersOf = new Map<string, string[]>();
  for (const group of groups) {
    const [representative] = group;
    membersOf.set(representative, [...group]);
    for (const member of group) aliases.set(member, representative);
  }

  const rows = await aggregateTermRows(
    window.windowMatch,
    window.recentStart,
    window.corpusByLanguage,
    clusteredTermsSql(aliases),
    membersOf,
  );
  for (const row of rows) {
    if (membersOf.has(row.measurement.term)) measured.set(row.measurement.term, row);
  }
  return measured;
}

/** Required breadth for a candidate, based on how explicitly authors named it. */
export function requiredAuthorsForTerm(input: { term: string; hashtagVolume: number }): number {
  return input.term.includes(' ') || input.hashtagVolume > 0
    ? MtnConfig.trending.detection.minAuthors
    : MtnConfig.trending.detection.minBareEntityAuthors;
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
  // The spam clause is `is not true`, not `< threshold`. A post with no spam
  // score at all (an unclassified post) must pass, and SQL's `<` would DROP
  // exactly those rows, silently shrinking both the corpus and every term's
  // count. `is not true` is total: NULL and false both pass.
  const windowMatch = and(
    notCollapsedCrosspostSql(),
    gte(posts.createdAt, windowStart),
    eq(posts.status, 'published'),
    eq(posts.visibility, PostVisibility.PUBLIC),
    // A trend is public; a private or followers-only profile's posts are not.
    openAudienceAuthorSql(),
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
  const window: TrendWindow = { windowMatch, recentStart, corpusByLanguage };
  if (!clustering.enabled || solo.length === 0) return { candidates: solo, graph: null, window };

  // Pass two, only when co-occurrence actually found a story spread across
  // several names. Re-counting rather than adding the members' volumes up is
  // the whole reason this is a second query: a post saying both `Ukraine` and
  // `Kyiv` is ONE post, and a sum would report it as two — inflating the very
  // number the reporting floors are applied to.
  const pairs = await loadTermPairs(
    windowMatch,
    solo.map((candidate) => candidate.measurement.term),
  );
  const conceptPairs = buildConceptPairs(solo);
  const { clusters, linkedPairs, refusedForSize, refusedForCoherence } = clusterTrendTerms(
    solo.map((candidate) => ({
      term: candidate.measurement.term,
      volume: candidate.measurement.volume,
    })),
    [...pairs, ...conceptPairs],
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
  if (refusedForCoherence.length > 0) {
    logger.info('[Trending] Bridge merges declined for story incoherence', {
      count: refusedForCoherence.length,
      pairs: refusedForCoherence.slice(0, 10),
    });
  }
  const aliases = buildClusterMap(clusters);
  // Second pass: names of one story that are not written in the same posts.
  const synchrony = await mergeSynchronizedStories(windowMatch, windowStart, solo, aliases);
  const allLinkedPairs = [...linkedPairs, ...synchrony.linkedPairs];

  if (aliases.size === 0) {
    // Edges but no stories is a real and informative state — it says the
    // network is talking about several separate things — so the graph is
    // still worth keeping.
    return {
      candidates: solo,
      graph: buildTrendGraph(now, graphNodes(solo), [...pairs, ...conceptPairs], [], new Map()),
      window,
    };
  }

  // A row's members, busiest first so the representative leads. Rebuilt from
  // the final aliases rather than from the clusters, because the second pass
  // can have folded one row into another.
  const soloVolume = new Map(solo.map((c) => [c.measurement.term, c.measurement.volume]));
  const membersOf = new Map<string, string[]>();
  for (const [member, representative] of aliases) {
    const list = membersOf.get(representative);
    if (list) list.push(member);
    else membersOf.set(representative, [member]);
  }
  for (const [representative, members] of membersOf) {
    members.sort(
      (left, right) =>
        (soloVolume.get(right) ?? 0) - (soloVolume.get(left) ?? 0) || left.localeCompare(right),
    );
    // The representative is the busiest member of the story as a whole.
    const lead = members.indexOf(representative);
    if (lead > 0) members.unshift(...members.splice(lead, 1));
  }
  logger.info('[Trending] Merged co-occurring terms into stories', {
    clusters: membersOf.size,
    merged: aliases.size,
    synchronized: synchrony.merged,
    synchronyMs: synchrony.elapsedMs,
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
  // A merged row keeps its busiest term as the retrieval key, but a bare word
  // is a poor NAME when the story is a person the posts write out in full.
  const named = merged.map((candidate) => {
    if (candidate.members.length < 2) return candidate;
    const labelTerm = pickLabelTerm(candidate.members, soloVolume);
    return labelTerm === candidate.measurement.term ? candidate : { ...candidate, labelTerm };
  });
  return {
    candidates: [...named, ...orphaned],
    // Built from the SOLO measurements, not the merged ones: an edge's two
    // ratios are `posts` over each endpoint's OWN volume, and a merged row
    // reports the story's volume instead. Reading a cluster total as a term
    // total is how a graph ends up drawing links that do not follow from its
    // own numbers.
    graph: buildTrendGraph(
      now,
      graphNodes(solo),
      [...pairs, ...conceptPairs],
      allLinkedPairs,
      aliases,
    ),
    window,
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
 * `lateral unnest` expands the term expression and the `group by` buckets per
 * term. `array_agg(distinct …)` gives the distinct-author set; the
 * `count(*) filter` clauses are the conditional sums.
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
  const { minVolume, maxActors, authorPostCap, minLanguageShare, minRegionShare } =
    MtnConfig.trending.detection;

  // TWO grouping levels, because volume is per-AUTHOR-capped: a term's volume
  // is assembled from what each author contributed, not from a flat post
  // count. `expanded` is the shared scan both levels read, so the corpus is
  // walked ONCE rather than once per level.
  const rows = await scan((db) =>
    db.execute<{
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
      -- it twice. This is where the per-post dedup lives. It is what makes the CLUSTERED
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
    -- The languages a term is actually BEING DISCUSSED IN, not every language
    -- any single post carrying it happened to be written in.
    --
    -- This was array_agg(distinct e.language) in the select below -- a UNION --
    -- and the union made the field nearly useless for its one reader.
    -- audience selection tests ANY overlap, so one English post was enough to
    -- mark a term English for every English reader. Measured on production
    -- 2026-09-05, a Japanese term reached an es,en reader tagged [en,ja].
    --
    -- The share test asks the question the field is named for. A genuinely
    -- bilingual term keeps both languages; the one-post tail drops.
    lang_share as (
      select term, language, count(*)::int as n
      from expanded
      where language is not null
      group by term, language
    ),
    lang_dominant as (
      select
        term,
        coalesce(
          array_agg(language order by n desc, language asc)
            -- Cast explicitly, for the reason the recent-window instant above
            -- carries its own cast: postgres infers a raw template parameter's
            -- type from its context, and a product against a bigint sum infers
            -- BIGINT, which then rejects 0.2 outright with
            -- "invalid input syntax for type bigint".
            filter (where n >= ${minLanguageShare}::double precision * total),
          array[]::text[]
        ) as languages
      from (
        select term, language, n, sum(n) over (partition by term) as total
        from lang_share
      ) shares
      group by term
    ),
    region_share as (
      select term, region, count(*)::int as n
      from expanded
      where region is not null
      group by term, region
    ),
    region_dominant as (
      select
        term,
        coalesce(
          array_agg(region order by n desc, region asc)
            filter (where n >= ${minRegionShare}::double precision * total),
          array[]::text[]
        ) as regions
      from (
        select term, region, n, sum(n) over (partition by term) as total
        from region_share
      ) shares
      group by term
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
      coalesce(l.languages, array[]::text[]) as "languages",
      coalesce(r.regions, array[]::text[]) as "regions"
    from expanded e
    join capped c on c.term = e.term
    left join lang_dominant l on l.term = e.term
    left join region_dominant r on r.term = e.term
    group by e.term, c.volume, c.recent_volume, l.languages, r.regions
    -- Cheapest possible narrowing, against the CAPPED volume — the number the
    -- floor is meant to be about.
    having c.volume >= ${minVolume}
  `),
  );

  return (
    rows
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
      // A capital in prose is useful but weaker evidence than an explicit tag or
      // a complete multi-word name. This is where generic institutional nouns
      // such as `Estado` and name fragments such as `City` otherwise scrape over
      // the global three-author floor and become fallback filler.
      .map((row) => {
        const languages = row.languages ?? [];
        const corpus = corpusSizeFor(languages, corpusByLanguage);
        const concept = resolveTrendConcept(row.term, languages);
        return {
          measurement: {
            term: row.term,
            volume: row.volume,
            recentVolume: row.recentVolume,
            authorCount: row.authorCount,
            requiredAuthorCount: requiredAuthorsForTerm(row),
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
          ...(concept ? { conceptId: concept.id } : {}),
        };
      })
  );
}

/**
 * Join reviewed aliases of one concept even when its language communities do
 * not write the same literal words in one post.  Both terms still had to clear
 * the ordinary volume and author floors in the same time window.
 */
function buildConceptPairs(candidates: readonly TermCandidate[]): TrendTermPair[] {
  const byConcept = new Map<string, TermCandidate[]>();
  for (const candidate of candidates) {
    if (!candidate.conceptId) continue;
    const group = byConcept.get(candidate.conceptId);
    if (group) group.push(candidate);
    else byConcept.set(candidate.conceptId, [candidate]);
  }

  const pairs: TrendTermPair[] = [];
  for (const group of byConcept.values()) {
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        pairs.push({
          a: group[left].measurement.term,
          b: group[right].measurement.term,
          posts: Math.min(group[left].measurement.volume, group[right].measurement.volume),
          reason: 'canonical-alias',
        });
      }
    }
  }
  return pairs;
}

/**
 * The candidate terms of a post with every clustered member rewritten to the
 * term its row is reported under.
 *
 * A `CASE` per merged member, applied to each element of the candidate union.
 * A post saying both `Ukraine` and `Kyiv` must not yield the representative
 * twice and get counted twice against the story; the `select distinct` inside
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
  termsSql: SQL = trendCandidateUnionSql(),
  minPairPosts: number = MtnConfig.trending.clustering.minPairPosts,
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
      from unnest(${termsSql}) as t(term)
      where t.term in (${floorTerms})
    ) as ${sql.raw(alias)}`;

    const rows = await scan((db) =>
      db
        .select({
          a: sql<string>`pair_a.term`,
          b: sql<string>`pair_b.term`,
          posts: sql`count(*)`.mapWith(Number),
        })
        .from(posts)
        // Self-join over the SAME per-post term set, one side renamed. `<` gives
        // each unordered pair exactly once and can never pair a term with
        // itself. A post carrying fewer than two of the terms produces no
        // row at all, so there is nothing to pre-filter.
        .innerJoin(postTerms('pair_a'), sql`true`)
        .innerJoin(postTerms('pair_b'), sql`pair_b.term > pair_a.term`)
        .where(windowMatch)
        .groupBy(sql`pair_a.term, pair_b.term`)
        // Applied here rather than in memory so the long tail of pairs that met
        // once never leaves the database.
        .having(sql`count(*) >= ${minPairPosts}`),
    );

    return rows.map((row) => ({ a: row.a, b: row.b, posts: row.posts }));
  } catch (error) {
    logger.warn('[Trending] Co-occurrence lookup failed; terms report individually', { error });
    return [];
  }
}

/** Which bin of the window a post falls in, as SQL; the last bin absorbs the edge. */
function binSql(windowStart: Date, binMs: number, bins: number): SQL<number> {
  return sql<number>`least(
    floor(
      extract(epoch from (${posts.createdAt} - ${windowStart.toISOString()}::timestamptz)) * 1000
      / ${binMs}::double precision
    )::int,
    ${bins - 1}::int
  )`;
}

/**
 * Every post of the window per bin: the denominator of a term's SHARE of an
 * hour. It does not depend on the term expression, so it is counted once per
 * batch rather than once per clustering round.
 */
async function loadBinTotals(windowMatch: SQL, bin: SQL<number>, bins: number): Promise<number[]> {
  const totals = new Array<number>(bins).fill(0);
  const rows = await scan((db) =>
    db
      .select({ bin, posts: sql`count(*)`.mapWith(Number) })
      .from(posts)
      .where(windowMatch)
      // By position: the bin expression carries bound parameters, and postgres
      // does not match a repeated parameterised expression to the select list.
      .groupBy(sql`1`),
  );
  for (const row of rows) totals[Number(row.bin)] += row.posts;
  return totals;
}

/**
 * Hourly post counts per term, oldest bin first.
 *
 * Counted per POST (a post carrying a term twice counts once), over the same
 * `windowMatch` every other count uses, and over the same term expression the
 * caller is clustering with — so a merged row's series is the story's series,
 * not a sum of its members' (which would count a post saying both names twice).
 */
async function loadTermSeries(
  windowMatch: SQL,
  bin: SQL<number>,
  bins: number,
  terms: readonly string[],
  termsSql: SQL,
): Promise<Map<string, number[]>> {
  const floorTerms = sql.join(
    terms.map((term) => sql`${term}`),
    sql`, `,
  );
  const rows = await scan((db) =>
    db
      .select({
        term: sql<string>`post_term.term`,
        bin,
        posts: sql`count(*)`.mapWith(Number),
      })
      .from(posts)
      .innerJoin(
        sql`lateral (
        select distinct t.term
        from unnest(${termsSql}) as t(term)
        where t.term in (${floorTerms})
      ) as post_term`,
        sql`true`,
      )
      .where(windowMatch)
      .groupBy(sql`1`, sql`2`),
  );

  const series = new Map<string, number[]>();
  for (const row of rows) {
    let values = series.get(row.term);
    if (!values) {
      values = new Array<number>(bins).fill(0);
      series.set(row.term, values);
    }
    values[Number(row.bin)] += row.posts;
  }
  return series;
}

/**
 * Join terms of one story that are not written in the same posts, by the shape
 * of their day (see {@link mergeSynchronizedTerms}).
 *
 * Series are read for every term common enough to share `minSharedPosts`, and
 * only the terms with a clear peak go on to the pair query. Each round re-measures
 * the GROUPS the last round made: `Chinese` sits beside no single name of the
 * story but well inside the whole of it, and only the merged row shows that.
 *
 * `aliases` is updated in place and holds every term of a merged row, the
 * representative mapping to itself — the shape `buildClusterMap` produces.
 */
async function mergeSynchronizedStories(
  windowMatch: SQL,
  windowStart: Date,
  solo: readonly TermCandidate[],
  aliases: Map<string, string>,
): Promise<{ linkedPairs: { a: string; b: string }[]; merged: number; elapsedMs: number }> {
  const startedAt = Date.now();
  const synchrony = MtnConfig.trending.synchrony;
  const linkedPairs: { a: string; b: string }[] = [];
  let merged = 0;
  if (!synchrony.enabled) return { linkedPairs, merged, elapsedMs: 0 };

  const { windowMs, recentWindowMs } = MtnConfig.trending.detection;
  const bins = Math.max(2, Math.ceil(windowMs / synchrony.binMs));
  const peakBins = Math.max(1, Math.round(recentWindowMs / synchrony.binMs));
  const rootOf = (term: string): string => aliases.get(term) ?? term;
  // A pair cannot share `minSharedPosts` posts if either term is rarer than it.
  const eligible = solo.filter(({ measurement }) => measurement.volume >= synchrony.minSharedPosts);

  try {
    const bin = binSql(windowStart, synchrony.binMs, bins);
    let corpus: number[] | null = null;

    for (let round = 0; round < synchrony.maxRounds; round += 1) {
      const termsSql = clusteredTermsSql(aliases);
      const rows = [...new Set(eligible.map(({ measurement }) => rootOf(measurement.term)))];
      if (rows.length < 2) break;

      // The cheap grouped scan first, so the expensive pair self-join only
      // runs over the terms that actually have a peak.
      corpus ??= await loadBinTotals(windowMatch, bin, bins);
      const series = await loadTermSeries(windowMatch, bin, bins, rows, termsSql);
      const peaked = rows.filter(
        (term) => peakShare(series.get(term) ?? [], peakBins) >= synchrony.minPeakShare,
      );
      const pairs = await loadTermPairs(windowMatch, peaked, termsSql, synchrony.minSharedPosts);
      if (pairs.length === 0) break;

      const membersByRoot = new Map<string, string[]>();
      for (const { measurement } of solo) {
        const root = rootOf(measurement.term);
        const members = membersByRoot.get(root);
        if (members) members.push(measurement.term);
        else membersByRoot.set(root, [measurement.term]);
      }

      const result = mergeSynchronizedTerms(
        peaked.flatMap((term) => {
          const counts = series.get(term);
          return counts
            ? [{ term, members: membersByRoot.get(term) ?? [term], series: counts }]
            : [];
        }),
        pairs,
        peakBins,
        corpus,
        synchrony,
      );
      if (result.refusedForSize.length > 0) {
        logger.info('[Trending] Synchrony merges declined for size', {
          count: result.refusedForSize.length,
          pairs: result.refusedForSize.slice(0, 10),
        });
      }
      if (result.merges.length === 0) break;

      // Every original term of an absorbed row follows it to the new row.
      const absorbedInto = new Map<string, string>();
      for (const merge of result.merges) {
        for (const absorbed of merge.absorbed) absorbedInto.set(absorbed, merge.representative);
        aliases.set(merge.representative, merge.representative);
      }
      for (const { measurement } of solo) {
        const next = absorbedInto.get(rootOf(measurement.term));
        if (next) aliases.set(measurement.term, next);
      }
      linkedPairs.push(...result.linkedPairs);
      merged += absorbedInto.size;
    }
  } catch (error) {
    // Fail-soft: what rounds already merged stands, and the rest of the batch
    // is exactly what co-occurrence alone produced.
    logger.warn('[Trending] Synchrony pass failed; keeping what was merged', { error });
  }

  return { linkedPairs, merged, elapsedMs: Date.now() - startedAt };
}

/**
 * How many posts the window held — the denominator of a term's share of the
 * corpus.
 *
 * Fail-soft to `null`: without it every candidate simply skips the vocabulary
 * ceiling, which is a weaker list for one batch. Throwing instead would trade
 * the whole batch for one guard.
 */
async function countWindowPostsByLanguage(windowMatch: SQL): Promise<Map<string | null, number>> {
  const byLanguage = new Map<string | null, number>();
  try {
    const rows = await scan((db) =>
      db
        .select({
          language: posts.language,
          count: sql`count(*)`.mapWith(Number),
        })
        .from(posts)
        .where(windowMatch)
        .groupBy(posts.language),
    );
    for (const row of rows) byLanguage.set(row.language, row.count);
  } catch (error) {
    logger.warn('[Trending] Corpus size lookup failed; vocabulary ceiling skipped', { error });
  }
  return byLanguage;
}
