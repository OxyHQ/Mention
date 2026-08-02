/**
 * The version-gated language backfill, against REAL ROWS.
 *
 * The previous version mocked `Post.find` and `Post.bulkWrite` over an in-memory
 * array and RE-IMPLEMENTED the selection filter in the test (`matchesFilter`) —
 * so "the right posts were selected" was an assertion that the test's copy of
 * the filter agreed with itself, and the real one could have matched nothing.
 * That filter is the whole script: four disjuncts, one of which
 * (`classification_version IS NULL`) is exactly the arm a literal translation of
 * the Mongo predicate drops, because `version < N` is NULL for an unstamped row
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
import { clearPostScope, postScope, seedPost } from './helpers/postFixtures';
import { BASELINE_CLASSIFIER_VERSION } from '../services/BaselineContentClassifier';
import { backfillPostLanguages } from '../scripts/backfillPostLanguages';

const scope = postScope('backfill-post-languages');

/** Enough Spanish for `tinyld` to reach a verdict; a six-word body is not. */
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

    await backfillPostLanguages({ batchSize: 100 });

    const after = await classificationOf(id);
    expect(after?.languages).toContain('es');
    expect(after?.version).toBe(BASELINE_CLASSIFIER_VERSION);
    expect(after?.language).toBe(after?.languages?.[0]);
  });

  it('re-derives a post stamped by an OLDER classifier version', async () => {
    const id = await seedUnclassified({
      content: { variants: [{ source: 'author', text: SPANISH, tag: 'es' }] },
      postClassification: { languages: ['xx'], version: BASELINE_CLASSIFIER_VERSION - 1 },
    });

    await backfillPostLanguages({ batchSize: 100 });

    const after = await classificationOf(id);
    expect(after?.languages).not.toContain('xx');
    expect(after?.version).toBe(BASELINE_CLASSIFIER_VERSION);
  });

  it('re-derives a post whose languages array is present but EMPTY', async () => {
    const id = await seedUnclassified({
      content: { variants: [{ source: 'author', text: ENGLISH, tag: 'en' }] },
      postClassification: { languages: [], version: BASELINE_CLASSIFIER_VERSION },
    });

    await backfillPostLanguages({ batchSize: 100 });

    expect((await classificationOf(id))?.languages).toContain('en');
  });

  it('is idempotent — a second run does not rewrite a completed row', async () => {
    const id = await seedUnclassified({
      content: { variants: [{ source: 'author', text: SPANISH, tag: 'es' }] },
    });

    await backfillPostLanguages({ batchSize: 100 });
    const first = await classificationOf(id);

    await backfillPostLanguages({ batchSize: 100 });
    const second = await classificationOf(id);

    // `updated_at` is maintained on every `db.update()`, so an unchanged stamp is
    // the evidence that the second run issued no write — a count of 0 updates
    // cannot say that on a corpus this file does not own.
    expect(second?.updatedAt).toEqual(first?.updatedAt);
    expect(second?.languages).toEqual(first?.languages);
  });

  it('leaves a post with no derivable language alone rather than fabricating one', async () => {
    const id = await seedUnclassified({
      content: { variants: [{ source: 'author', text: 'hi', tag: undefined }] },
    });

    await backfillPostLanguages({ batchSize: 100 });

    const after = await classificationOf(id);
    // Never an EMPTY array either: that would stamp the post as classified and
    // remove it from every later run's selection.
    expect(after?.languages).toBeNull();
    expect(after?.version).toBeNull();
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
      ids.push(await seedUnclassified({
        content: { variants: [{ source: 'author', text: `${ENGLISH} Number ${i}.`, tag: 'en' }] },
      }));
    }

    await backfillPostLanguages({ batchSize: 1 });

    for (const id of ids) {
      expect((await classificationOf(id))?.version).toBe(BASELINE_CLASSIFIER_VERSION);
    }
  });
});
