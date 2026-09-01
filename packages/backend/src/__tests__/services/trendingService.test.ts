/**
 * Trending CANDIDATE AGGREGATION, against real rows.
 *
 * The one pipeline that measures every term, and every property it carries
 * fails SILENTLY when it breaks — a sensitive post that reaches a trend, a term
 * space that quietly narrows back to hashtags, an author floor computed from
 * posts. None of them raises anything; they just produce a plausible list.
 *
 * The suite this replaces asserted the SHAPE of a Mongo `$match`/`$group`
 * object. It could tell you the pipeline named `metadata.isSensitive`, and
 * nothing at all about whether a sensitive post ever reached a trend. Every
 * assertion below is on the returned MEASUREMENT, computed from rows.
 *
 * Terms are namespaced per run: sibling suites share one database and one
 * `posts` table, so a bare term like `news` is a claim about every other file in
 * the run. `mine()` narrows every assertion to this file's own terms.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, inArray } from 'drizzle-orm';
import { MtnConfig } from '@mention/shared-types';

// Trending pulls in side-effecting collaborators the aggregation never touches.
vi.mock('../../utils/socket', () => ({ emitTrendsUpdated: vi.fn() }));
vi.mock('../../utils/oxyInference', () => ({ inferenceChat: vi.fn(), isInferenceEnabled: () => false }));

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { trendTermMatchSql, TREND_CANDIDATE_COLUMNS, TREND_TERM_COLUMNS } from '../../services/trending/termSpace';
/**
 * The aggregation returns the candidates AND the co-occurrence graph behind
 * them. The graph is `null` when clustering is off — the only thing these cases
 * read is `candidates`, but destructuring it keeps the shape honest.
 */
import { aggregateTermCandidates } from '../../services/trending/trendDetection';

/** The floor the aggregation applies before a candidate is returned at all. */
const MIN_VOLUME = MtnConfig.trending.detection.minVolume;

let db: Database;
const createdPostIds: string[] = [];
const RUN = randomUUID().slice(0, 8);

/** A term unique to this run. Lowercase — the aggregation groups on the stored value. */
function term(name: string): string {
  return `${name}${RUN}`;
}

/** Inside the 24-hour window and inside the six-hour recent one. */
function recently(minutesAgo = 30): Date {
  return new Date(Date.now() - minutesAgo * 60 * 1000);
}

interface SeedOptions {
  trendTerms?: string[];
  hashtags?: string[];
  classificationTopics?: string[];
  oxyUserId?: string | null;
  language?: string;
  createdAt?: Date;
  status?: 'published' | 'draft';
  visibility?: 'public' | 'private';
  classificationSensitive?: boolean;
  metadataIsSensitive?: boolean;
  federationSensitive?: boolean;
  spamScore?: number;
  isBoost?: boolean;
}

async function seedPost(options: SeedOptions = {}): Promise<string> {
  const [row] = await db
    .insert(posts)
    .values({
      status: options.status ?? 'published',
      visibility: options.visibility ?? 'public',
      createdAt: options.createdAt ?? recently(),
      oxyUserId: options.oxyUserId === undefined ? `author-${RUN}-${createdPostIds.length}` : options.oxyUserId,
      language: options.language ?? 'en',
      classificationTrendTerms: options.trendTerms,
      hashtags: options.hashtags,
      classificationTopics: options.classificationTopics,
      classificationSensitive: options.classificationSensitive,
      metadataIsSensitive: options.metadataIsSensitive ?? false,
      federationSensitive: options.federationSensitive,
      ...(options.spamScore === undefined ? {} : { classificationScoreSpam: options.spamScore }),
    })
    .returning({ id: posts.id });
  createdPostIds.push(row.id);

  if (options.isBoost) {
    // A boost points at an original; the aggregation excludes anything that does.
    await db.update(posts).set({ boostOf: row.id }).where(inArray(posts.id, [row.id]));
  }
  return row.id;
}

/** Seed `count` posts, each by a DIFFERENT author, all carrying `options`. */
async function seedMany(count: number, options: SeedOptions = {}): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await seedPost(options);
  }
}

/** This run's candidates only — a sibling suite's rows can never match. */
function mine(candidates: TermCandidateView[], terms: string[]): TermCandidateView[] {
  return candidates.filter((candidate) => terms.includes(candidate.measurement.term));
}

async function candidatesFor(terms: string[]): Promise<TermCandidateView[]> {
  const { candidates } = await aggregateTermCandidates(new Date());
  return mine(candidates, terms);
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  if (createdPostIds.length > 0) {
    await db.delete(posts).where(inArray(posts.id, createdPostIds));
    createdPostIds.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('aggregateTermCandidates — what is allowed to count', () => {
  it('excludes every sensitive flag independently, and each is nullable', async () => {
    /**
     * The three flags are INDEPENDENTLY sufficient and each is nullable, so a
     * predicate written as `= false` would silently drop every post that has
     * never been classified — the overwhelming majority. Seeding one post per
     * flag beside a clean cohort is what tells "excluded the sensitive ones"
     * apart from "excluded everything".
     */
    const clean = term('clean');
    await seedMany(MIN_VOLUME, { trendTerms: [clean] });
    await seedPost({ trendTerms: [clean], classificationSensitive: true });
    await seedPost({ trendTerms: [clean], metadataIsSensitive: true });
    await seedPost({ trendTerms: [clean], federationSensitive: true });

    const [candidate] = await candidatesFor([clean]);

    expect(candidate).toBeDefined();
    expect(candidate.measurement.volume).toBe(MIN_VOLUME);
  });

  it('excludes drafts, non-public posts and boosts', async () => {
    const gated = term('gated');
    await seedMany(MIN_VOLUME, { trendTerms: [gated] });
    await seedPost({ trendTerms: [gated], status: 'draft' });
    await seedPost({ trendTerms: [gated], visibility: 'private' });
    await seedPost({ trendTerms: [gated], isBoost: true });

    const [candidate] = await candidatesFor([gated]);

    expect(candidate.measurement.volume).toBe(MIN_VOLUME);
  });

  it('excludes a post the deterministic classifier already scored as spam', async () => {
    /**
     * The clause has to be TOTAL. Mongo's `{ $not: { $gte: n } }` matched a post
     * with no spam score at all; SQL's `< n` would DROP those, shrinking every
     * count. The unclassified post below is the one that proves `is not true`
     * was written rather than `<`.
     */
    const scored = term('scored');
    const reject = MtnConfig.feed.discoveryGate.spamRejectThreshold;
    await seedMany(MIN_VOLUME - 1, { trendTerms: [scored], spamScore: 0 });
    await seedPost({ trendTerms: [scored] }); // never classified — must still count
    await seedPost({ trendTerms: [scored], spamScore: reject });

    const [candidate] = await candidatesFor([scored]);

    expect(candidate.measurement.volume).toBe(MIN_VOLUME);
  });

  it('drops blocklisted NSFW terms but keeps ordinary ones from the same posts', async () => {
    const ordinary = term('ordinary');
    // `porn` is on the NSFW blocklist and is NOT namespaced — that is the point:
    // the blocklist matches the bare term, so it must be seeded bare.
    await seedMany(MIN_VOLUME, { trendTerms: [ordinary, 'porn'] });

    const { candidates } = await aggregateTermCandidates(new Date());

    expect(candidates.map((c) => c.measurement.term)).toContain(ordinary);
    expect(candidates.map((c) => c.measurement.term)).not.toContain('porn');
  });

  it('applies the volume floor, so a term below it never becomes a candidate', async () => {
    const thin = term('thin');
    await seedMany(MIN_VOLUME - 1, { trendTerms: [thin] });

    expect(await candidatesFor([thin])).toEqual([]);
  });
});

describe('aggregateTermCandidates — ONE term space', () => {
  it('groups a hashtag and the bare word into a SINGLE candidate', async () => {
    /**
     * The whole reason the three columns are unioned: the previous design ranked
     * hashtags and topics in separate lanes, so the lane that was cheapest to
     * fill decided the output and trending read as a hashtag ranking.
     */
    const unified = term('unified');
    await seedMany(3, { trendTerms: [unified] });
    await seedMany(3, { hashtags: [unified] });

    const candidates = await candidatesFor([unified]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].measurement.volume).toBe(6);
  });

  it('counts a post once even when it carries the term in two columns', async () => {
    const doubled = term('doubled');
    await seedMany(MIN_VOLUME, { trendTerms: [doubled], hashtags: [doubled] });

    const [candidate] = await candidatesFor([doubled]);

    expect(candidate.measurement.volume).toBe(MIN_VOLUME);
  });

  it('reaches a post that predates term extraction through its hashtags alone', async () => {
    // A post written before the classifier emitted `trendTerms` has a NULL
    // column; the union must not turn that into "no terms at all".
    const legacy = term('legacy');
    await seedMany(MIN_VOLUME, { hashtags: [legacy] });

    const [candidate] = await candidatesFor([legacy]);

    expect(candidate.measurement.volume).toBe(MIN_VOLUME);
  });
});

describe('aggregateTermCandidates — authors are people, not posts', () => {
  it('DISCOUNTS one loud author instead of counting their posts', async () => {
    /**
     * The floor is applied to volume, and posts are the thing one account can
     * manufacture: fifty posts from one author is not a trend, and counting
     * posts alone made that indistinguishable from fifty people agreeing.
     *
     * Every author now counts at most `authorPostCap` times, so this term's
     * volume is 2 however many times the one account said it — below the floor,
     * so it never becomes a candidate at all. Nothing has to be identified as a
     * bot for that to work, which is the whole point of discounting rather than
     * refusing.
     */
    const shouty = term('shouty');
    for (let i = 0; i < MIN_VOLUME + 2; i += 1) {
      await seedPost({ trendTerms: [shouty], oxyUserId: `one-author-${RUN}` });
    }

    expect(await candidatesFor([shouty])).toEqual([]);
  });

  it('CONTROL: the same post count spread across authors DOES clear the floor', async () => {
    // The discriminating pair. Same number of posts as the case above, the only
    // difference being how many people said it — which is exactly what volume is
    // now measuring.
    const widely = term('widely');
    for (let i = 0; i < MIN_VOLUME + 2; i += 1) {
      await seedPost({ trendTerms: [widely], oxyUserId: `spread-${RUN}-${i}` });
    }

    const [candidate] = await candidatesFor([widely]);

    expect(candidate.measurement.volume).toBe(MIN_VOLUME + 2);
    expect(candidate.measurement.authorCount).toBe(MIN_VOLUME + 2);
  });

  it('counts an author TWICE, not once — saying something twice is ordinary', async () => {
    // The cap is 2 rather than 1 deliberately: at 1 the volume floor would be a
    // second copy of `minAuthors`, and a person repeating themselves carries
    // real signal about what they are engaged with.
    const twice = term('twice');
    for (let i = 0; i < 2; i += 1) {
      await seedPost({ trendTerms: [twice], oxyUserId: `pair-a-${RUN}` });
      await seedPost({ trendTerms: [twice], oxyUserId: `pair-b-${RUN}` });
    }

    const [candidate] = await candidatesFor([twice]);

    expect(candidate.measurement.volume).toBe(4);
    expect(candidate.measurement.authorCount).toBe(2);
  });

  it('does not let orphan posts with no author inflate the author count', async () => {
    // A legacy orphan federated post is a real post and counts toward volume,
    // but it cannot testify to WHO is posting — which would be the one way to
    // walk straight past the author floor.
    const orphaned = term('orphaned');
    await seedMany(2, { trendTerms: [orphaned] });
    for (let i = 0; i < MIN_VOLUME; i += 1) {
      await seedPost({ trendTerms: [orphaned], oxyUserId: null });
    }

    const [candidate] = await candidatesFor([orphaned]);

    // Volume 4: one from each real author, plus the orphans capped at 2 — they
    // share a single NULL author group, so a flood of authorless posts cannot
    // walk past the floor either.
    expect(candidate.measurement.volume).toBe(MIN_VOLUME);
    expect(candidate.measurement.authorCount).toBe(2);
    expect(candidate.actorIds).toHaveLength(2);
  });

  it('caps the stored actor sample at maxActors', async () => {
    const crowded = term('crowded');
    const authors = MtnConfig.trending.detection.maxActors + 3;
    await seedMany(authors, { trendTerms: [crowded] });

    const [candidate] = await candidatesFor([crowded]);

    expect(candidate.measurement.authorCount).toBe(authors);
    expect(candidate.actorIds).toHaveLength(MtnConfig.trending.detection.maxActors);
  });
});

describe('aggregateTermCandidates — provenance is carried, not scored', () => {
  it('counts how often the term arrived as a hashtag and as a topic slug', async () => {
    // Provenance decides the row's `type` and gates the topic-registry lookup.
    // Nothing about the score depends on it, which is why it travels separately.
    //
    // Note the shape of the fixture: the topic-slug posts ALSO carry the term as
    // an extracted one. A post carrying it only as a slug we assigned is not a
    // candidate at all — see the two cases below — so seeding one here would
    // measure the candidate rule rather than the provenance counters.
    const mixed = term('mixed');
    await seedMany(2, { hashtags: [mixed] });
    await seedMany(2, { trendTerms: [mixed], classificationTopics: [mixed] });
    await seedMany(2, { trendTerms: [mixed] });

    const [candidate] = await candidatesFor([mixed]);

    expect(candidate.measurement.volume).toBe(6);
    expect(candidate.hashtagVolume).toBe(2);
    expect(candidate.topicVolume).toBe(2);
  });

  it('does NOT let our own topic slugs propose a trend', async () => {
    // A topic slug is a drawer WE file a post into, so its count answers "how
    // many posts did we shelve here" rather than "how many people are talking
    // about this". Counted as a candidate it put `News` and `Politics` on the
    // live list with five posts and no burst — a bookshop announcing that its
    // bestseller is "Fiction". The category still LABELS a trend; it is not one.
    const shelved = term('shelved');
    await seedMany(MIN_VOLUME + 2, { classificationTopics: [shelved] });

    expect(await candidatesFor([shelved])).toEqual([]);
    expect(TREND_CANDIDATE_COLUMNS).not.toContain(posts.classificationTopics);
  });

  it('still MATCHES a topic slug when serving a trend it did not propose', async () => {
    // The asymmetry is the point, and only in this direction: a feed matching
    // less than detection counted would open a trend onto a screen missing the
    // posts that made it trend. Matching more can only add posts that are about
    // it — one we filed under `ukraine` belongs in Ukraine's feed whether or not
    // its author ever typed the word.
    const served = term('served');
    await seedPost({ classificationTopics: [served] });

    const rows = await db
      .select({ id: posts.id })
      .from(posts)
      .where(and(inArray(posts.id, createdPostIds), trendTermMatchSql(served)));
    expect(rows).toHaveLength(1);
    expect(TREND_TERM_COLUMNS).toContain(posts.classificationTopics);
  });

  it('carries the primary languages of the posts behind the term, ignoring the unset ones', async () => {
    const bilingual = term('bilingual');
    await seedMany(3, { trendTerms: [bilingual], language: 'es' });
    await seedMany(2, { trendTerms: [bilingual], language: 'en' });

    const [candidate] = await candidatesFor([bilingual]);

    expect([...candidate.languages].sort()).toEqual(['en', 'es']);
  });

  it('separates the recent window from the trailing one', async () => {
    // `recentVolume` is the numerator of the burst statistic; counting the whole
    // window into it would make every term look like it is breaking now.
    const bursty = term('bursty');
    await seedMany(3, { trendTerms: [bursty], createdAt: recently(10) });
    await seedMany(2, {
      trendTerms: [bursty],
      // Inside the 24-hour window, outside the six-hour one.
      createdAt: new Date(Date.now() - 12 * 60 * 60 * 1000),
    });

    const [candidate] = await candidatesFor([bursty]);

    expect(candidate.measurement.volume).toBe(5);
    expect(candidate.measurement.recentVolume).toBe(3);
  });
});
