/**
 * The version-gated language backfill, against REAL ROWS.
 *
 * The previous version mocked `Post.find` and `Post.bulkWrite` over an in-memory
 * array and RE-IMPLEMENTED the selection filter in the test (`matchesFilter`) —
 * so "the right posts were selected" was an assertion that the test's copy of
 * the filter agreed with itself, and the real one could have matched nothing.
 * That filter is the whole script: four disjuncts, one of which
 * (`classification_version IS NULL`) is exactly the arm a literal translation of
 * the legacy-store predicate drops, because `version < N` is NULL for an unstamped row
 * and a NULL predicate excludes it — silently skipping the posts that were never
 * classified at all, which is most of the corpus this exists for.
 *
 * So the query runs for real and every assertion below reads a stored row. The
 * classifier was already real and stays real: it is pure and synchronous, and a
 * stubbed one would make "derives Spanish" a statement about the stub.
 *
 * ## This script sweeps the WHOLE corpus, and that is visible here
 *
 * `backfillPostLanguages` takes no scope — by design, it is a one-shot over
 * every qualifying post. One database serves the parallel run, so it also visits
 * rows other files seeded. Nothing below asserts on the run's aggregate counters
 * for that reason: every assertion names a post this file wrote.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';
import type { PostRecordInput } from '../db/posts/postRecord';
import { loadPostRecord } from '../db/posts/postRepository';
import { clearPostScope, postScope, seedPost } from './helpers/postFixtures';
import { BASELINE_CLASSIFIER_VERSION } from '../services/BaselineContentClassifier';
import {
  backfillPostLanguages,
  EXCERPT_LENGTH,
  LanguageChangeReport,
  NO_LANGUAGE,
  REPORT_SAMPLES_PER_PAIR,
  REPORT_SAMPLED_PAIRS,
  REPORT_TOP_PAIRS,
} from '../scripts/backfillPostLanguages';
import { clearAdminScriptCursor, readAdminScriptCursor } from '../scripts/lib/adminScriptCursor';

const scope = postScope('backfill-post-languages');

/** The real rate bound, without the real waiting. */
const NO_WAIT = { sleep: async () => {} };

/** Enough Spanish for the language detector to reach a verdict; a six-word body is not. */
const SPANISH = 'Hola, ¿cómo estás hoy amigo? Espero que tengas un día estupendo por allí.';
const ENGLISH = 'This is a clearly English sentence written for language detection.';

/** The three columns the backfill writes, as stored. */
async function classificationOf(id: string) {
  const [row] = await getDb()
    .select({
      languages: posts.classificationLanguages,
      version: posts.classificationVersion,
      language: posts.language,
      updatedAt: posts.updatedAt,
    })
    .from(posts)
    .where(eq(posts.id, id));
  return row;
}

async function seedUnclassified(overrides: Partial<PostRecordInput> = {}): Promise<string> {
  const record = await seedPost(scope, overrides);
  return record.id;
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  await clearPostScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('backfillPostLanguages', () => {
  it('derives the language of a post that was NEVER classified', async () => {
    // `classification_version IS NULL` — the disjunct a literal `version < N`
    // translation drops, and the state most of the corpus is actually in.
    const id = await seedUnclassified({
      content: { variants: [{ source: 'author', text: SPANISH, tag: 'es' }] },
    });
    expect((await classificationOf(id))?.version).toBeNull();

    await backfillPostLanguages({ batchSize: 100, pacing: NO_WAIT });

    const after = await classificationOf(id);
    expect(after?.languages).toContain('es');
    expect(after?.version).toBe(BASELINE_CLASSIFIER_VERSION);
    expect(after?.language).toBe(after?.languages?.[0]);
  });

  it('re-derives a post that has languages but NO stamped version', async () => {
    // The `classification_version IS NULL` arm on its own. Removing it survives
    // a fixture whose languages are also absent — the first arm covers that —
    // so the state has to be languages PRESENT, version NULL: a row a
    // pre-versioning writer left behind, whose scores nothing may trust.
    // (Mutation-tested: dropping the arm passes without this case.)
    const id = await seedUnclassified({
      content: { variants: [{ source: 'author', text: SPANISH, tag: 'es' }] },
      postClassification: { languages: ['xx'] },
    });
    const before = await classificationOf(id);
    expect(before?.languages).toEqual(['xx']);
    expect(before?.version).toBeNull();

    await backfillPostLanguages({ batchSize: 100, pacing: NO_WAIT });

    const after = await classificationOf(id);
    expect(after?.languages).toContain('es');
    expect(after?.version).toBe(BASELINE_CLASSIFIER_VERSION);
  });

  it('re-derives a post stamped by an OLDER classifier version', async () => {
    const id = await seedUnclassified({
      content: { variants: [{ source: 'author', text: SPANISH, tag: 'es' }] },
      postClassification: { languages: ['xx'], version: BASELINE_CLASSIFIER_VERSION - 1 },
    });

    await backfillPostLanguages({ batchSize: 100, pacing: NO_WAIT });

    const after = await classificationOf(id);
    expect(after?.languages).not.toContain('xx');
    expect(after?.version).toBe(BASELINE_CLASSIFIER_VERSION);
  });

  it('re-derives a post whose languages array is present but EMPTY', async () => {
    const id = await seedUnclassified({
      content: { variants: [{ source: 'author', text: ENGLISH, tag: 'en' }] },
      postClassification: { languages: [], version: BASELINE_CLASSIFIER_VERSION },
    });

    await backfillPostLanguages({ batchSize: 100, pacing: NO_WAIT });

    expect((await classificationOf(id))?.languages).toContain('en');
  });

  it('repairs the primary tag: untagged takes the language, a contradicted declaration is replaced', async () => {
    const untagged = await seedUnclassified({
      content: { variants: [{ source: 'author', text: SPANISH }] },
      postClassification: { languages: [], version: BASELINE_CLASSIFIER_VERSION },
    });
    // Classified correctly, but stored under the origin's default `de` tag.
    const contradicted = await seedUnclassified({
      content: { variants: [{ source: 'author', text: ENGLISH, tag: 'de' }] },
      language: 'en',
      postClassification: { languages: ['en'], version: BASELINE_CLASSIFIER_VERSION },
    });

    await backfillPostLanguages({ batchSize: 100, pacing: NO_WAIT });

    expect((await classificationOf(untagged))?.languages).toEqual(['es']);
    expect((await loadPostRecord(untagged))?.content.variants?.[0]?.tag).toBe('es');
    expect((await loadPostRecord(contradicted))?.content.variants?.[0]?.tag).toBe('en');
  });

  it('is idempotent — a second run does not rewrite a completed row', async () => {
    const id = await seedUnclassified({
      content: { variants: [{ source: 'author', text: SPANISH, tag: 'es' }] },
    });

    await backfillPostLanguages({ batchSize: 100, pacing: NO_WAIT });
    const first = await classificationOf(id);

    await backfillPostLanguages({ batchSize: 100, pacing: NO_WAIT });
    const second = await classificationOf(id);

    // `updated_at` is maintained on every `db.update()`, so an unchanged stamp is
    // the evidence that the second run issued no write — a count of 0 updates
    // cannot say that on a corpus this file does not own.
    expect(second?.updatedAt).toEqual(first?.updatedAt);
    expect(second?.languages).toEqual(first?.languages);
  });

  it('clears stale language claims when no language is safely derivable', async () => {
    const id = await seedUnclassified({
      content: { variants: [{ source: 'author', text: 'hi', tag: undefined }] },
      language: 'en',
      postClassification: { languages: ['en'], version: BASELINE_CLASSIFIER_VERSION - 1 },
    });

    await backfillPostLanguages({ batchSize: 100, pacing: NO_WAIT });

    const after = await classificationOf(id);
    expect(after?.languages).toEqual([]);
    expect(after?.language).toBeNull();
    expect(after?.version).toBe(BASELINE_CLASSIFIER_VERSION);
  });

  it('writes nothing under --dry-run', async () => {
    const id = await seedUnclassified({
      content: { variants: [{ source: 'author', text: SPANISH, tag: 'es' }] },
    });
    const before = await classificationOf(id);

    const result = await backfillPostLanguages({ dryRun: true });

    // The report still counts what it WOULD do, which is the point of a dry run.
    expect(result.updated).toBeGreaterThanOrEqual(1);
    expect(await classificationOf(id)).toEqual(before);
  });

  it('pages past the batch size and finishes the whole corpus', async () => {
    // `batchSize: 1` forces the ascending-id cursor to advance page by page. A
    // cursor that failed to advance would loop forever or stop after one row;
    // both are invisible at a batch size that fits everything in one page.
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push(
        await seedUnclassified({
          content: { variants: [{ source: 'author', text: `${ENGLISH} Number ${i}.`, tag: 'en' }] },
        }),
      );
    }

    await backfillPostLanguages({ batchSize: 1, pacing: NO_WAIT });

    for (const id of ids) {
      expect((await classificationOf(id))?.version).toBe(BASELINE_CLASSIFIER_VERSION);
    }
  });

  it('reports (old → new) pairs largest first, capped, with lowest-id samples for the top pairs', () => {
    const report = new LanguageChangeReport();
    const longText =
      'Avui fa un dia molt bonic i anirem a la platja amb els nens i després dinarem a casa.';
    // More pairs than are listed; the first pair is the largest and has more
    // rows than samples are kept. Rows arrive in ascending id order, as the
    // scan delivers them.
    for (let pair = 0; pair < REPORT_TOP_PAIRS + 2; pair += 1) {
      const rows = pair === 0 ? REPORT_SAMPLES_PER_PAIR + 2 : 1;
      for (let row = 0; row < rows; row += 1) {
        report.add({
          postId: `p${pair}-${row}`,
          text: longText,
          from: pair === 0 ? 'fr' : `x${pair}`,
          to: pair === 0 ? 'ca' : NO_LANGUAGE,
          retagged: pair === 0,
        });
      }
    }

    const pairs = report.top();

    expect(pairs).toHaveLength(REPORT_TOP_PAIRS);
    expect(pairs[0]).toMatchObject({
      from: 'fr',
      to: 'ca',
      count: REPORT_SAMPLES_PER_PAIR + 2,
      retagged: REPORT_SAMPLES_PER_PAIR + 2,
    });
    expect(pairs[0].samples.map((sample) => sample.postId)).toEqual(
      Array.from({ length: REPORT_SAMPLES_PER_PAIR }, (_, row) => `p0-${row}`),
    );
    expect(pairs[0].samples[0].excerpt).toBe(longText.slice(0, EXCERPT_LENGTH));
    // Only the largest pairs carry samples.
    expect(pairs.slice(0, REPORT_SAMPLED_PAIRS).every((pair) => pair.samples.length > 0)).toBe(
      true,
    );
    expect(pairs.slice(REPORT_SAMPLED_PAIRS).every((pair) => pair.samples.length === 0)).toBe(true);
  });

  it('resumes strictly after START_AFTER_ID, records its cursor, and paces every write', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push(
        await seedUnclassified({
          content: { variants: [{ source: 'author', text: `${ENGLISH} Number ${i}.` }] },
        }),
      );
    }
    ids.sort();
    const cursorScope = `test-${scope.name}`;
    const sleeps: number[] = [];

    try {
      await backfillPostLanguages({
        batchSize: 100,
        startAfterId: ids[0],
        cursorScope,
        pacing: {
          rowsPerSecond: 10,
          writeBatchSize: 1,
          pauseMs: 0,
          now: () => 0,
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        },
      });

      expect((await classificationOf(ids[0]))?.version).toBeNull();
      expect((await classificationOf(ids[1]))?.version).toBe(BASELINE_CLASSIFIER_VERSION);
      expect((await classificationOf(ids[2]))?.version).toBe(BASELINE_CLASSIFIER_VERSION);
      // One row per transaction at 10 rows/s: at least 100 ms after each.
      expect(sleeps.length).toBeGreaterThanOrEqual(2);
      for (const ms of sleeps) expect(ms).toBeGreaterThanOrEqual(100);

      const stored = await readAdminScriptCursor('backfillPostLanguages', cursorScope);
      expect(stored?.completedAt).not.toBeNull();
      expect(stored && stored.cursor >= ids[2]).toBe(true);
    } finally {
      await clearAdminScriptCursor('backfillPostLanguages', cursorScope);
    }
  });
});
