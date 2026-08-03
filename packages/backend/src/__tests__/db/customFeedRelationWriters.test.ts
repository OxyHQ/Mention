import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

/**
 * `custom_feed_source_lists` and `custom_feed_topics` are read in an order they
 * cannot promise — and this is the tripwire for the day that starts mattering.
 *
 * ## The finding
 *
 * `db/feeds/customFeedRepository.ts` loads four child collections of one custom
 * feed in a single `Promise.all`. Two of them carry an explicit `position`
 * column and are ordered by it; the other two have NO `position` column at all
 * and fall back to `orderBy(asc(<table>.id))`:
 *
 * | table                         | ordered by |
 * |-------------------------------|------------|
 * | `custom_feed_definition_modules` | `asc(position)` |
 * | `custom_feed_members`            | `asc(position)` |
 * | `custom_feed_source_lists`       | **`asc(id)`** |
 * | `custom_feed_topics`             | **`asc(id)`** |
 *
 * `id` is a `uuidv7()` from `db/schema/columns.ts`: 48 bits of millisecond
 * timestamp then pure randomness, with NO monotonic counter. Rows written in one
 * batch therefore share a millisecond and their relative order is decided by the
 * random tail — so **the stored order of these two relations is not the order
 * they were inserted in.**
 *
 * It is arbitrary but STABLE: a uuid never changes once written, so a given set
 * of rows reads back the same way every time. Nothing flaps. The hazard is
 * narrower than "random order" suggests, and it is precisely this: *insertion
 * order is not recoverable.*
 *
 * ## Why that is harmless TODAY — both grounds verified, not assumed
 *
 *  1. **Nothing outside the backfill writes these tables.** The only producer is
 *     `db/backfill/plans/feeds.ts`, which emits rows from the Mongo documents.
 *     No request path inserts into either.
 *  2. **Nothing reads them as a sequence.** `customFeedRepository.ts` says so
 *     outright where it assembles the DTO: `sourceListIds` and `topicIds` are
 *     deliberately left off `CustomFeedSource` because `legacyCustomFeedToDefinition`
 *     reads neither, so no resolver consults their order.
 *
 * ## Why this is a TEST and not a comment
 *
 * A comment saying "revisit this if someone adds a writer" is not a mechanism —
 * it stays quiet forever and is read only by people already looking at the file.
 * The day a custom-feed EDITOR is built it will write both relations in one
 * batch, and the order the user arranged will be silently unrecoverable from
 * that moment on, permanently, for every feed it touches. That is a bug nobody
 * would think to look for, because nothing errors.
 *
 * So the rule is enforced instead: **the set of files allowed to name these two
 * relations is pinned.** Add a writer — or any new reader — and this goes red and
 * says why. The fix at that point is the `position` column its two siblings
 * already have, plus a migration; that two of four siblings were given one is the
 * strongest available evidence that whoever built this considered order
 * meaningful there and not here.
 *
 * Widening {@link ALLOWED} is a deliberate act, and the point is that it makes
 * whoever does it read the paragraph above first.
 */

/** `packages/backend/src`, derived from this file rather than from a cwd. */
const SRC_ROOT = join(__dirname, '..', '..');

const RELATIONS = ['customFeedSourceLists', 'customFeedTopics'] as const;

/**
 * Every file permitted to name either relation, and why. Sorted, and compared as
 * a SET — a file that stops referencing them fails this too, because that means
 * the reasoning above has moved and the next reader should be told where.
 */
const ALLOWED: ReadonlyArray<{ path: string; because: string }> = [
  { path: 'db/backfill/plans/feeds.ts', because: 'the ONLY writer: emits both relations from the Mongo documents' },
  { path: 'db/feeds/customFeedRepository.ts', because: 'the two reads — the `asc(id)` ordering this test exists for' },
  { path: 'db/schema/deferredForeignKeys.ts', because: 'declares the deferred FK on custom_feed_topics.topic_id' },
  { path: 'db/schema/feeds.ts', because: 'defines both tables' },
];

/** A source file that names at least one of {@link RELATIONS}, as a repo path. */
function findReferencingFiles(root: string): string[] {
  const found: string[] = [];
  let scanned = 0;

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Tests are excluded on purpose: this pins what PRODUCTION code touches.
        // A fixture naming the relation is not a writer.
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      scanned += 1;
      const source = readFileSync(full, 'utf8');
      // Word-boundary on the IDENTIFIER, not a substring: `customFeedTopics`
      // must not be matched by `customFeedTopicsSomethingElse`. Comments and
      // strings are deliberately NOT stripped — a chained comment/string strip
      // pass desyncs on an apostrophe and reports zero for a dense file, which
      // reads as success; a false positive here is loud and one line to diagnose,
      // which is the safer failure direction for a tripwire.
      if (RELATIONS.some((name) => new RegExp(`\\b${name}\\b`).test(source))) {
        found.push(relative(root, full).split(sep).join('/'));
      }
    }
  };

  walk(root);
  return found.sort().concat(`__scanned__:${scanned}`);
}

/** Split the sentinel the walker appends so a broken traversal cannot read as "no hits". */
function scan(root: string): { files: string[]; scanned: number } {
  const raw = findReferencingFiles(root);
  const sentinel = raw[raw.length - 1];
  return { files: raw.slice(0, -1), scanned: Number(sentinel.split(':')[1]) };
}

describe('custom-feed child relations — who is allowed to name them', () => {
  it('is exactly the pinned set, so a new writer or reader cannot land unnoticed', () => {
    const { files } = scan(SRC_ROOT);

    expect(files).toEqual(ALLOWED.map((entry) => entry.path).sort());
  });

  it('still finds every file the pin names — the positive control', () => {
    // Without this the suite above passes just as well against a scanner that
    // matches NOTHING: an empty result set compared to an empty allowlist is
    // green. Asserting the known four are actually detected is what makes the
    // first case evidence rather than an accident.
    const { files } = scan(SRC_ROOT);

    for (const { path } of ALLOWED) {
      expect(files).toContain(path);
    }
  });

  it('scanned a plausible share of the tree — the vacuity floor', () => {
    // A walker that threw on one directory, or an `endsWith('.ts')` that stopped
    // matching, would report zero references and pass every assertion above.
    const { scanned } = scan(SRC_ROOT);

    expect(scanned).toBeGreaterThan(400);
  });

  it('DETECTS a writer that does not exist yet — proof this can fail', () => {
    // A tripwire nobody has seen fail is indistinguishable from one that cannot.
    // Rather than mutate the real tree — which is how a temporary edit ends up in
    // somebody else's commit — the detector is run against a fixture holding the
    // exact shape of the future change: a request-path file inserting into one of
    // the two relations in a single batch.
    const fixture = mkdtempSync(join(tmpdir(), 'customfeed-writer-'));
    try {
      mkdirSync(join(fixture, 'routes'), { recursive: true });
      writeFileSync(
        join(fixture, 'routes', 'customFeedEditor.ts'),
        [
          "import { customFeedTopics } from '../db/schema/feeds';",
          'export async function saveTopics(db, feedId, topicIds) {',
          '  await db.insert(customFeedTopics).values(',
          '    topicIds.map((topicId) => ({ feedId, topicId })),',
          '  );',
          '}',
        ].join('\n'),
      );

      const { files } = scan(fixture);

      expect(files).toEqual(['routes/customFeedEditor.ts']);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('does not match an identifier that merely starts with the same characters', () => {
    // The word boundary, stated as its own case: a substring match would make the
    // pin fire on unrelated future names and get it disabled by whoever hit it.
    const fixture = mkdtempSync(join(tmpdir(), 'customfeed-nearmiss-'));
    try {
      writeFileSync(
        join(fixture, 'nearMiss.ts'),
        'export const customFeedTopicsArchive = 1;\nexport const myCustomFeedTopics = 2;\n',
      );

      expect(scan(fixture).files).toEqual([]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
