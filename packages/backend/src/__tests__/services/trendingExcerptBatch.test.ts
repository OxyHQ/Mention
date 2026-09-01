/**
 * Trend-label EVIDENCE, batched into one statement, against real rows.
 *
 * `resolveTrendLabels` used to fan out one excerpt query per unlabelled term
 * with `Promise.all` — up to `MtnConfig.trending.labeling.maxPerBatch` statements
 * issued at once, each holding a pool connection and asking for its own parallel
 * workers on an instance that is also serving requests.
 *
 * The rewrite submits the SAME per-term queries as one `union all`. That makes
 * the total server-side work identical by construction (measured on a
 * 400k-post corpus: 9,419 buffers either way, to three digits) and changes only
 * how it is demanded. Which is precisely why the tests here are about
 * EQUIVALENCE rather than speed: a batching rewrite is only worth anything if
 * every term still receives exactly the evidence it received before, in the same
 * order, because that evidence is what names the trend a reader sees.
 *
 * Four properties, each of which fails silently in production:
 *
 *  1. same excerpts, same order, per term — asserted against the per-term query
 *     itself, executed one term at a time;
 *  2. a term matching nothing keeps its ENTRY (an omitted group would become a
 *     missing key and a crashed labeller, or a silently weaker label);
 *  3. a failure degrades the WHOLE batch to no-evidence labels instead of
 *     throwing — the failure's blast radius grew with the batch, so the catch
 *     had to as well;
 *  4. it really is ONE statement.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';

vi.mock('../../utils/socket', () => ({ emitTrendsUpdated: vi.fn() }));
vi.mock('../../utils/oxyInference', () => ({ inferenceChat: vi.fn(), isInferenceEnabled: () => false }));

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { insertPostRecord } from '../../db/posts/postRepository';
/**
 * `termExcerptBranch` is the per-term query — the thing that used to be run N
 * times. Executing it directly IS the reference implementation for property 1;
 * it is not a re-implementation of the code under test, it is the shared
 * building block the batch is assembled from, which is what isolates the
 * assertion to the BATCHING (the union, the grouping, the ordering).
 */
import { loadExcerptsByTerm, termExcerptBranch } from '../../services/trending/trendExcerpts';

let db: Database;
const createdPostIds: string[] = [];

/** Terms are namespaced per run: sibling suites share one `posts` table. */
const RUN = randomUUID().slice(0, 8);
function term(name: string): string {
  return `${name}${RUN}`;
}

interface Seed {
  /** Which column carries the term — all three are part of the term space. */
  column?: 'trendTerms' | 'hashtags' | 'topics';
  minutesAgo?: number;
  sensitive?: boolean;
  status?: 'published' | 'draft';
  visibility?: 'public' | 'private';
  /** Omit the rendition entirely — a post with no `content.variants`. */
  withoutBody?: boolean;
}

async function seedPost(termName: string, body: string, seed: Seed = {}): Promise<string> {
  const column = seed.column ?? 'trendTerms';
  const record = await insertPostRecord({
    oxyUserId: `author-${RUN}-${createdPostIds.length}`,
    authorship: [{
      oxyUserId: `author-${RUN}-${createdPostIds.length}`,
      role: 'owner',
      status: 'accepted',
    }],
    status: seed.status ?? 'published',
    visibility: seed.visibility ?? 'public',
    createdAt: new Date(Date.now() - (seed.minutesAgo ?? 10) * 60 * 1000),
    content: seed.withoutBody ? { variants: [] } : { variants: [{ source: 'author', text: body }] },
    ...(column === 'hashtags' ? { hashtags: [termName] } : {}),
    postClassification: {
      ...(column === 'trendTerms' ? { trendTerms: [termName] } : {}),
      ...(column === 'topics' ? { topics: [termName] } : {}),
      ...(seed.sensitive ? { sensitive: true } : {}),
    },
  });
  createdPostIds.push(record.id);
  return record.id;
}

/** The per-term query, run one term at a time — property 1's reference. */
async function perTerm(termName: string): Promise<string[]> {
  const rows = await termExcerptBranch(termName);
  return rows.map((row) => row.body);
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (createdPostIds.length > 0) {
    await db.delete(posts).where(inArray(posts.id, createdPostIds));
    createdPostIds.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('loadExcerptsByTerm — the batch must be the per-term queries, exactly', () => {
  it('gives every term the same excerpts, in the same order, as querying it alone', async () => {
    const alpha = term('alpha');
    const beta = term('beta');
    const gamma = term('gamma');

    // Distinct `created_at` per post, so "the same order" is a real claim and
    // not two arbitrary tie orders that happen to agree. Each term is carried by
    // a DIFFERENT column, so the three-way term space is exercised too.
    await seedPost(alpha, 'alpha oldest', { minutesAgo: 30 });
    await seedPost(alpha, 'alpha middle', { minutesAgo: 20 });
    await seedPost(alpha, 'alpha newest', { minutesAgo: 10 });
    await seedPost(beta, 'beta only', { column: 'hashtags', minutesAgo: 15 });
    await seedPost(gamma, 'gamma older', { column: 'topics', minutesAgo: 25 });
    await seedPost(gamma, 'gamma newer', { column: 'topics', minutesAgo: 5 });

    const batched = await loadExcerptsByTerm([alpha, beta, gamma]);

    // Newest first, per term.
    expect(batched.get(alpha)).toEqual(['alpha newest', 'alpha middle', 'alpha oldest']);
    expect(batched.get(beta)).toEqual(['beta only']);
    expect(batched.get(gamma)).toEqual(['gamma newer', 'gamma older']);

    // And the same as the per-term query, which is the property that survives a
    // future change to what the branch selects.
    for (const name of [alpha, beta, gamma]) {
      const reference = await perTerm(name);
      // FLOOR: an equality between two empty lists would pass while proving
      // nothing, and every term here really does have evidence.
      expect(reference.length).toBeGreaterThan(0);
      expect(batched.get(name)).toEqual(reference);
    }
  });

  it('applies the same exclusions the per-term query did', async () => {
    const scoped = term('scoped');

    await seedPost(scoped, 'visible', { minutesAgo: 5 });
    await seedPost(scoped, 'sensitive', { sensitive: true, minutesAgo: 4 });
    await seedPost(scoped, 'draft', { status: 'draft', minutesAgo: 3 });
    await seedPost(scoped, 'private', { visibility: 'private', minutesAgo: 2 });
    // No rendition at all: the INNER JOIN eliminates it, so it must not consume
    // one of the twelve slots and must not appear as an empty excerpt.
    await seedPost(scoped, '', { withoutBody: true, minutesAgo: 1 });

    const batched = await loadExcerptsByTerm([scoped]);

    expect(batched.get(scoped)).toEqual(['visible']);
    expect(batched.get(scoped)).toEqual(await perTerm(scoped));
  });

  it('keeps an ENTRY for a term that matches nothing', async () => {
    const present = term('present');
    const absent = term('absent');
    await seedPost(present, 'something');

    const batched = await loadExcerptsByTerm([present, absent]);

    // `has`, not `get`, is the assertion that matters: a `union all` emits no
    // rows for an empty branch, so an implementation that built the map FROM the
    // result would drop the key and hand the labeller `undefined`.
    expect(batched.has(absent)).toBe(true);
    expect(batched.get(absent)).toEqual([]);
    expect(batched.get(present)).toEqual(['something']);
  });

  it('is ONE statement, whatever the batch size', async () => {
    const terms = Array.from({ length: 12 }, (_unused, index) => term(`bulk${index}`));
    for (const [index, name] of terms.entries()) await seedPost(name, `body ${index}`);

    const execute = vi.spyOn(db, 'execute');

    const batched = await loadExcerptsByTerm(terms);

    // Exactly one, not "at most" one: 0 would mean the batch stopped going
    // through `execute` at all (a revert to per-term builders reads as 0, not as
    // 12), and the value assertions below are what make that distinguishable
    // from a call that did nothing.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(batched.size).toBe(12);
    for (const [index, name] of terms.entries()) {
      expect(batched.get(name)).toEqual([`body ${index}`]);
    }
  });

  it('degrades the WHOLE batch to no evidence when the query fails, rather than throwing', async () => {
    const first = term('failfirst');
    const second = term('failsecond');
    await seedPost(first, 'real evidence');
    await seedPost(second, 'more evidence');

    // The failure shape that matters is the statement failing, which is now one
    // statement for every term — the blast radius the per-term version did not
    // have. A throw here would take down the whole labelling run.
    vi.spyOn(db, 'execute').mockRejectedValueOnce(new Error('connection reset'));

    const batched = await loadExcerptsByTerm([first, second]);

    expect(batched.get(first)).toEqual([]);
    expect(batched.get(second)).toEqual([]);
    // The keys survive, so `resolveTrendLabels` still labels every term — just
    // without evidence, which is the documented fail-soft.
    expect([...batched.keys()].sort()).toEqual([first, second].sort());
  });
});
