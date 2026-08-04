/**
 * The COPY encoder, differential-tested against drizzle's parameter binding.
 *
 * Hand-rolling Postgres' `COPY` text format is the one genuinely dangerous part
 * of the bulk loader: a wrong escape corrupts data SILENTLY, which is precisely
 * the failure the migration exists to avoid. Asserting the encoder against a
 * hand-written expectation would only prove it agrees with whoever wrote the
 * expectation.
 *
 * So every case below is loaded TWICE into the same real table — once through
 * `copyRowsInto` (the encoder) and once through `db.insert().values()` (drizzle
 * binding it as a parameter, correct by construction) — and the STORED values
 * are compared. A divergence fails naming the column.
 *
 * `gifs` is the table under test because it is the one that exercises the
 * hazardous types together: `text` (tab/newline/backslash/quote/NUL-adjacent
 * payloads), `text[]` (an array literal whose elements contain commas, braces
 * and the literal word NULL), `integer`, `boolean`, `timestamptz`, plus a
 * GENERATED `tsvector` that must never be written.
 */

import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb, getPostgresClient } from '../../db/postgres';
import { gifs } from '../../db/schema/discovery';
import {
  applyDefaultFns,
  copyRowsInto,
  encodeCopyValue,
  groupByColumnSet,
  peekNextStagingName,
} from '../../db/backfill/bulkLoad';
import { buildRow, BackfillRowError } from '../../db/backfill/rowBuilder';

const created: string[] = [];

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  if (created.length === 0) return;
  await getDb()
    .delete(gifs)
    .where(inArray(gifs.id, created.splice(0)));
});

afterAll(async () => {
  await closePostgres();
});

/** A `gifs` row with every column the differential compares. */
function gifRow(id: string, title: string, tags: string[]): Record<string, unknown> {
  return {
    id,
    klipyId: `k-${id}`,
    source: 'klipy',
    slug: 'shared-slug',
    title,
    searchTerms: tags,
    width: 480,
    height: 270,
    mp4FileId: 'shared-mp4',
    previewFileId: 'shared-preview',
    useCount: 7,
    searchHitCount: 3,
    lastUsedAt: new Date('2026-03-04T05:06:07.008Z'),
    createdAt: new Date('2026-03-04T05:06:07.008Z'),
    updatedAt: new Date('2026-03-04T05:06:07.008Z'),
  };
}

describe('COPY encoder vs drizzle parameter binding', () => {
  const cases: Array<{ name: string; title: string; tags: string[] }> = [
    { name: 'plain text', title: 'a plain title', tags: ['alpha', 'beta'] },
    { name: 'tabs', title: 'before\tafter', tags: ['with\ttab'] },
    { name: 'newlines', title: 'line one\nline two', tags: ['a\nb'] },
    { name: 'carriage returns', title: 'crlf\r\nhere', tags: ['c\rr'] },
    { name: 'backslashes', title: 'C:\\path\\to\\thing', tags: ['back\\slash'] },
    { name: 'a literal \\N', title: '\\N', tags: ['\\N'] },
    { name: 'double quotes', title: 'she said "hi"', tags: ['"quoted"'] },
    { name: 'commas and braces', title: 'a,b{c}d', tags: ['x,y', '{z}', 'p"q'] },
    { name: 'the literal word NULL', title: 'NULL', tags: ['NULL', 'null'] },
    { name: 'unicode and emoji', title: 'héllo — 世界 🎉', tags: ['ünï', '🎉'] },
    // An empty TITLE only. `gifs.search_vector` is
    // `array_to_tsvector(search_terms)`, and Postgres refuses an empty lexeme
    // ("lexeme array may not contain empty strings") — on BOTH paths equally,
    // so it is a property of the table rather than of the encoder. The
    // encoder's own handling of an empty array ELEMENT is asserted directly in
    // the `encodeCopyValue` block below, where no generated column is involved.
    { name: 'an empty string', title: '', tags: ['nonempty'] },
    { name: 'an empty array', title: 'empty tags', tags: [] },
  ];

  for (const testCase of cases) {
    it(`round-trips ${testCase.name} identically through both paths`, async () => {
      const db = getDb();
      const copyId = `copy-${testCase.name.replace(/[^a-z0-9]/gi, '')}`;
      const insertId = `ins-${testCase.name.replace(/[^a-z0-9]/gi, '')}`;
      created.push(copyId, insertId);

      const viaCopy = buildRow(gifs, gifRow(copyId, testCase.title, testCase.tags), copyId);
      const viaInsert = buildRow(gifs, gifRow(insertId, testCase.title, testCase.tags), insertId);

      await copyRowsInto(getPostgresClient(), gifs, [viaCopy]);
      await db.insert(gifs).values(viaInsert as typeof gifs.$inferInsert);

      const [copied] = await db.select().from(gifs).where(eq(gifs.id, copyId));
      const [inserted] = await db.select().from(gifs).where(eq(gifs.id, insertId));

      expect(copied).toBeDefined();
      expect(inserted).toBeDefined();

      // Compare every column except the two that MUST differ between the two
      // rows: the primary key, and `klipy_id`, which carries a unique
      // constraint (`gifs_klipy_id_key`). Every other column holds the same
      // payload on both paths, so any difference is the encoder's.
      const { id: _cid, klipyId: _ck, ...copiedRest } = copied as Record<string, unknown>;
      const { id: _iid, klipyId: _ik, ...insertedRest } = inserted as Record<string, unknown>;
      expect(copiedRest).toStrictEqual(insertedRest);

      // And assert the payload actually survived, so a mutual corruption that
      // matched on both paths could not pass.
      expect((copied as { title: string }).title).toBe(testCase.title);
      expect((copied as { searchTerms: string[] }).searchTerms).toStrictEqual(testCase.tags);
    });
  }

  it('is idempotent — a second COPY of the same row inserts nothing', async () => {
    const db = getDb();
    const id = 'copy-idempotent';
    created.push(id);
    const row = buildRow(gifs, gifRow(id, 'once', ['a']), id);

    await copyRowsInto(getPostgresClient(), gifs, [row]);
    await copyRowsInto(getPostgresClient(), gifs, [{ ...row, title: 'twice' }]);

    const rows = await db.select().from(gifs).where(eq(gifs.id, id));
    expect(rows).toHaveLength(1);
    // ON CONFLICT DO NOTHING: the FIRST write wins and the second is discarded.
    // This is exactly why `--start-from-empty` exists — a re-run never
    // refreshes a row it already wrote.
    expect(rows[0]?.title).toBe('once');
  });

  it('survives a staging table left behind by a crashed run', async () => {
    // The regression: the staging name is `pid + counter`, and in a container
    // the pid is 1 and the counter restarts at 0, so every run generates the
    // SAME names. A run that dies hard skips the drop, and the next run then
    // fails on `42P07 already exists` — nowhere near the collection at fault.
    //
    // The name has to be the EXACT one the loader is about to use; a guessed
    // high counter would make this pass whether or not the fix is present.
    const squatted = peekNextStagingName();
    await getPostgresClient().unsafe(`create table "${squatted}" (bogus text)`);

    const id = 'copy-after-crash';
    created.push(id);
    try {
      await copyRowsInto(getPostgresClient(), gifs, [
        buildRow(gifs, gifRow(id, 'after a crash', ['x']), id),
      ]);
    } finally {
      await getPostgresClient().unsafe(`drop table if exists "${squatted}"`);
    }

    const rows = await getDb().select().from(gifs).where(eq(gifs.id, id));
    expect(rows).toHaveLength(1);
  });
});

describe('encodeCopyValue', () => {
  it('renders null and undefined as the NULL marker', () => {
    expect(encodeCopyValue(null, 'text')).toBe('\\N');
    expect(encodeCopyValue(undefined, 'text')).toBe('\\N');
  });

  it('escapes the four reserved characters and nothing else', () => {
    expect(encodeCopyValue('a\tb\nc\rd\\e', 'text')).toBe('a\\tb\\nc\\rd\\\\e');
    expect(encodeCopyValue('plain "quoted" ,{}', 'text')).toBe('plain "quoted" ,{}');
  });

  it('distinguishes an array COLUMN from a json column by the declared type', () => {
    // The JS value is identical; only the column type can decide.
    expect(encodeCopyValue(['a', 'b'], 'text[]')).toBe('{"a","b"}');
    expect(encodeCopyValue(['a', 'b'], 'jsonb')).toBe('["a","b"]');
  });

  it('quotes an empty array element so it survives as an empty string', () => {
    expect(encodeCopyValue(['', 'a'], 'text[]')).toBe('{"","a"}');
  });

  it('writes a null array element as the unquoted keyword', () => {
    // Quoting it would store the four-character string "NULL".
    expect(encodeCopyValue(['a', null], 'text[]')).toBe('{"a",NULL}');
    expect(encodeCopyValue(['NULL'], 'text[]')).toBe('{"NULL"}');
  });

  it('refuses a value it cannot render rather than guessing', () => {
    expect(() => encodeCopyValue(Symbol('x'), 'text')).toThrow(/Cannot encode symbol/);
  });
});

describe('groupByColumnSet', () => {
  it('keeps an OMITTED column separate from an explicit null', () => {
    // A COPY has one fixed column list, so grouping is what stops "omitted"
    // (let the default apply) from silently becoming NULL.
    const groups = groupByColumnSet([{ a: 1, b: 2 }, { a: 1 }, { a: 1, b: null }]);
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.rows.length).sort()).toStrictEqual([1, 2]);
  });

  it('treats key ORDER as the same column set', () => {
    const groups = groupByColumnSet([
      { a: 1, b: 2 },
      { b: 2, a: 1 },
    ]);
    expect(groups).toHaveLength(1);
  });
});

describe('applyDefaultFns', () => {
  it('fills a $defaultFn column COPY would otherwise leave absent', () => {
    // `generatedId()` is a $defaultFn, not a database DEFAULT — Postgres 17 has
    // no native uuidv7() — so drizzle's insert supplies one and COPY does not.
    const [filled] = applyDefaultFns(gifs, [{ klipyId: 'k' }]);
    expect(typeof filled?.id).toBe('string');
    expect((filled?.id as string).length).toBeGreaterThan(0);
  });

  it('never overwrites a value the transform supplied', () => {
    const [filled] = applyDefaultFns(gifs, [{ id: 'explicit', klipyId: 'k' }]);
    expect(filled?.id).toBe('explicit');
  });
});

describe('buildRow', () => {
  it('refuses a GENERATED column rather than letting Postgres reject it later', () => {
    // `gifs.search_vector` is GENERATED ALWAYS ... STORED. Postgres raises
    // 428C9, but only once the statement reaches the server — i.e. after a
    // batch is assembled, at hour three of a real run.
    expect(() => buildRow(gifs, { ...gifRow('g', 't', []), searchVector: 'x' })).toThrow(
      BackfillRowError
    );
    expect(() => buildRow(gifs, { ...gifRow('g', 't', []), searchVector: 'x' })).toThrow(
      /GENERATED ALWAYS/
    );
  });

  it('refuses an unknown key, which drizzle would have DROPPED silently', () => {
    expect(() => buildRow(gifs, { ...gifRow('g', 't', []), 'content.title': 'x' })).toThrow(
      /is not a column of this table/
    );
  });

  it('refuses `undefined`, because omit and null are different answers', () => {
    expect(() => buildRow(gifs, { ...gifRow('g', 't', []), title: undefined })).toThrow(
      /Supply `null` to write SQL NULL, or OMIT the key/
    );
  });

  it('refuses a NOT NULL column with no default and no value, naming the document', () => {
    expect(() => buildRow(gifs, { id: 'g' }, 'src-123')).toThrow(/source _id src-123/);
  });
});
