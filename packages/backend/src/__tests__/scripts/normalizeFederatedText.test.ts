/**
 * The one-shot backfill that cleans the remote text already stored, against REAL
 * ROWS on both sides.
 *
 * Two layers are covered:
 *
 *  - The pure update-builders, which hold every rule that matters: which helper
 *    each field gets, that an emptied optional label is UNSET rather than
 *    blanked, that a required field is never emptied, and that a document with
 *    nothing to fix produces no write at all (the idempotency the batch loop
 *    relies on to avoid rewriting hundreds of thousands of clean posts).
 *
 *  - The scan itself. It is what proves the DRY RUN is real: it must write
 *    nothing while still reporting exactly what a real run would rewrite.
 *
 * ## Why the builder is fed LOADED records rather than literals
 *
 * `buildPostUpdate` used to take a hand-written object, which meant its reads
 * (`post.content.variants[i].text`, `post.content.media[i].alt`,
 * `post.federation.spoilerText`) were only ever checked against a shape the test
 * itself invented. A post is nine tables now and the assembled record is what
 * the script actually sees, so every case here seeds the row and hands the
 * builder what `loadPostRecord` returns. The positional paths the plan emits
 * (`content.media.1.alt`) are then indexes into the STORED order rather than
 * into an array the test happened to write.
 *
 * ## The scan is corpus-wide, which shapes what can be asserted
 *
 * `POST_SCAN_FILTER` is `undefined` — every post is a candidate, deliberately,
 * because media `alt` is dirty on native rows too. One database serves the
 * parallel run, so `scanned` (and a real run's writes) legitimately include other
 * files' rows. Assertions therefore name this file's own posts and read their
 * stored columns; the global counters are only ever compared against each other.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { postContentVariants, postMedia } from '../../db/schema/postContent';
import { loadPostRecord } from '../../db/posts/postRepository';
import type { PostRecord, PostRecordInput } from '../../db/posts/postRecord';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';
import {
  clearFederationScope,
  federationScope,
  readActor,
  seedActor,
} from '../helpers/federationFixtures';
import {
  buildActorUpdate,
  buildPostUpdate,
  describeChanges,
  normalizeStoredText,
} from '../../scripts/normalizeFederatedText';
import { extractApSummary } from '../../connectors/activitypub/apPostContent';
import { normalizeAlt } from '../../services/MediaMetadataService';

const scope = federationScope('normalize-federated-text');
const postFixtures = postScope('normalize-federated-text');
const AUTHOR = postFixtures.user('author');
const DIRTY_ACTOR_URI = `${scope.origin}/users/alice`;
const CLEAN_ACTOR_URI = `${scope.origin}/users/bob`;

/** The body of a pretty-printed remote post: padded, with a padded blank line. */
const DIRTY_TEXT = '  uno   \n   \n   \n  dos  ';
const CLEAN_TEXT = 'uno\n\ndos';

/** Marks a post as FEDERATED — presence of the subdocument is the whole test. */
function remote(extra: Record<string, unknown> = {}) {
  return { activityId: `${scope.origin}/activities/${Math.random()}`, ...extra };
}

/** Seed a post and hand back the record the script would actually see. */
async function seedRecord(overrides: Partial<PostRecordInput> = {}): Promise<PostRecord> {
  return seedPost(postFixtures, {
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    ...overrides,
  });
}

/** The stored body of each rendition, in position order. */
async function storedVariantBodies(postId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ body: postContentVariants.body })
    .from(postContentVariants)
    .where(eq(postContentVariants.postId, postId))
    .orderBy(asc(postContentVariants.position));
  return rows.map((row) => row.body);
}

/** The stored `alt` of each media item, in position order. */
async function storedMediaAlts(postId: string): Promise<Array<string | null>> {
  const rows = await getDb()
    .select({ alt: postMedia.alt })
    .from(postMedia)
    .where(eq(postMedia.postId, postId))
    .orderBy(asc(postMedia.position));
  return rows.map((row) => row.alt);
}

async function storedSpoilerText(postId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ spoilerText: posts.federationSpoilerText })
    .from(posts)
    .where(eq(posts.id, postId));
  return row?.spoilerText ?? null;
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  await clearFederationScope(scope);
});

afterEach(async () => {
  await clearFederationScope(scope);
  await clearPostScope(postFixtures);
});

afterAll(async () => {
  await closePostgres();
});

describe('buildPostUpdate', () => {
  it('normalizes the body as multiline, keeping the author’s paragraph break', async () => {
    // A federated post with no content warning: `federation` is PRESENT, which
    // is what makes the body eligible.
    const post = await seedRecord({
      content: { variants: [{ source: 'author', text: DIRTY_TEXT, tag: 'es' }] },
      federation: remote(),
    });

    const { update, counts } = buildPostUpdate(post);

    expect(update.set['content.variants.0.text']).toBe(CLEAN_TEXT);
    expect(update.unset).toEqual({});
    expect(counts.text).toBe(1);
  });

  it('never rewrites the body of a NATIVE post — that text is the local author’s', async () => {
    // The scan covers every post now (native alt is dirty too), so what a row IS
    // has to decide which of its fields are eligible.
    const post = await seedRecord({
      content: {
        variants: [{ source: 'author', text: DIRTY_TEXT, tag: 'es' }],
        media: [{ id: 'file-a', type: 'image', alt: '  un gato\n  en una caja ' }],
      },
    });

    const { update, counts } = buildPostUpdate(post);

    expect(update.set).toEqual({ 'content.media.0.alt': 'un gato en una caja' });
    expect(counts).toEqual({ text: 0, spoilerText: 0, mediaAlt: 1 });
  });

  it('normalizes the content warning as inline text', async () => {
    const post = await seedRecord({ federation: remote({ spoilerText: '  CW:\n  spoilers  ' }) });

    const { update, counts } = buildPostUpdate(post);

    expect(update.set['federation.spoilerText']).toBe('CW: spoilers');
    expect(counts.spoilerText).toBe(1);
  });

  it('STRIPS THE MARKUP of a content warning the old ingest stored raw', async () => {
    // The ingest that wrote these rows persisted the AP `summary` verbatim, and a
    // Mastodon summary arrives as HTML on plenty of servers. A backfill that only
    // collapsed whitespace would leave `<p>…</p>` in the database forever.
    const post = await seedRecord({
      federation: remote({ spoilerText: '<p>\n  Spoilers de <strong>la peli</strong>\n</p>' }),
    });

    const { update, counts } = buildPostUpdate(post);

    expect(update.set['federation.spoilerText']).toBe('Spoilers de la peli');
    expect(counts.spoilerText).toBe(1);
  });

  it('UNSETS a content warning and an alt that normalize to nothing', async () => {
    // These are optional labels read as "present ⇒ show it", so a value that
    // normalizes away must disappear, not become an empty string.
    const post = await seedRecord({
      federation: remote({ spoilerText: '   \n  ' }),
      content: {
        variants: [{ source: 'author', text: CLEAN_TEXT, tag: 'es' }],
        media: [{ id: 'file-a', type: 'image', alt: '  \n ' }],
      },
    });

    const { update } = buildPostUpdate(post);

    expect(update.unset).toEqual({
      'federation.spoilerText': '',
      'content.media.0.alt': '',
    });
    expect(update.set['federation.spoilerText']).toBeUndefined();
  });

  it('addresses media alt by STORED position so the item’s other fields are never rewritten', async () => {
    const post = await seedRecord({
      content: {
        variants: [{ source: 'author', text: CLEAN_TEXT, tag: 'es' }],
        media: [
          { id: 'file-a', type: 'image', alt: 'ya limpio' },
          { id: 'file-b', type: 'image', width: 100, alt: '  un gato\n  en una caja ' },
        ],
      },
    });

    const { update, counts } = buildPostUpdate(post);

    // Only the dirty item's `alt` path is written, and the index is the stored
    // `position` — so the write lands on that one row and `id`/`type`/`width`
    // are never re-serialized.
    expect(update.set).toEqual({ 'content.media.1.alt': 'un gato en una caja' });
    expect(counts.mediaAlt).toBe(1);
  });

  it('produces NO write for an already-clean post (idempotent)', async () => {
    const post = await seedRecord({
      content: {
        variants: [{ source: 'author', text: CLEAN_TEXT, tag: 'es' }],
        media: [{ id: 'file-a', type: 'image', alt: 'un gato' }],
      },
      federation: remote({ spoilerText: 'CW: spoilers' }),
    });

    const { update } = buildPostUpdate(post);

    expect(update.set).toEqual({});
    expect(update.unset).toEqual({});
  });
});

/**
 * THE invariant this backfill lives or dies by: for the same input, it must produce
 * exactly what the INGEST would produce today. Anything less and it "cleans" a row
 * into a state no fresh write could ever reach — a second, divergent rule.
 *
 * It is not asserted against hardcoded strings but against the ingest functions
 * themselves, so the two can never drift apart without this failing.
 */
describe('the backfill reproduces the ingest', () => {
  /** Raw values as the OLD ingest stored them: HTML, padding, entities, empties. */
  const STORED_SUMMARIES = [
    '<p>Spoilers</p>',
    '<p>\n  Spoilers de <strong>la peli</strong>\n</p>',
    'CW:\n  spoilers',
    'A &amp; B',
    '<p>a</p><p>b</p>',
    'ya limpio',
    '   ',
  ];

  it.each(STORED_SUMMARIES)('spoilerText: %j lands on exactly what the ingest extracts', async (stored) => {
    // What the ingest would write for this value if the Note arrived again today.
    const ingested = extractApSummary({ summary: stored });
    const post = await seedRecord({ federation: remote({ spoilerText: stored }) });

    const { update } = buildPostUpdate(post);

    if (ingested === stored) {
      // Already what the ingest produces: the backfill must not write at all.
      expect(update.set['federation.spoilerText']).toBeUndefined();
      expect(update.unset['federation.spoilerText']).toBeUndefined();
      return;
    }
    if (ingested === undefined) {
      // The ingest would omit the field, so the stored one must DISAPPEAR — a CW is
      // read as "present ⇒ show it", and a blank label would render as an empty CW.
      expect(update.unset['federation.spoilerText']).toBe('');
      expect(update.set['federation.spoilerText']).toBeUndefined();
      return;
    }
    expect(update.set['federation.spoilerText']).toBe(ingested);
  });

  const STORED_ALTS = ['  un gato\n  en una caja ', 'ya limpio', ' \n ', 'a  b'];

  it.each(STORED_ALTS)('media alt: %j lands on exactly what the alt rule produces', async (stored) => {
    const canonical = normalizeAlt(stored);
    const post = await seedRecord({
      content: {
        variants: [{ source: 'author', text: CLEAN_TEXT, tag: 'es' }],
        media: [{ id: 'file-a', type: 'image', alt: stored }],
      },
    });

    const { update } = buildPostUpdate(post);

    if (canonical === stored) {
      expect(update.set['content.media.0.alt']).toBeUndefined();
      expect(update.unset['content.media.0.alt']).toBeUndefined();
      return;
    }
    if (canonical === undefined) {
      expect(update.unset['content.media.0.alt']).toBe('');
      return;
    }
    expect(update.set['content.media.0.alt']).toBe(canonical);
  });
});

describe('buildActorUpdate', () => {
  it('normalizes the username inline and the bio as a body', () => {
    const { update, counts } = buildActorUpdate({
      id: 'actor-1',
      username: '  alice\n ',
      summary: '  línea uno   \n  \n  \n  línea dos ',
    });

    expect(update.set.username).toBe('alice');
    expect(update.set.summary).toBe('línea uno\n\nlínea dos');
    expect(counts.username).toBe(1);
    expect(counts.summary).toBe(1);
  });

  it('never empties the username — it is required and half of a unique index', () => {
    const { update, counts } = buildActorUpdate({ id: 'actor-1', username: '   \n ' });
    expect(update.set.username).toBeUndefined();
    expect(counts.username).toBe(0);
  });

  it('normalizes profile fields by index, preserving the untouched entries', () => {
    const { update, counts } = buildActorUpdate({
      id: 'actor-1',
      fields: [
        { name: 'Web', value: 'carol.example' },
        { name: '  Sitio\n  web ', value: '  carol.example\n ' },
      ],
    });

    expect(update.set).toEqual({
      'fields.1.name': 'Sitio web',
      'fields.1.value': 'carol.example',
    });
    expect(counts.fields).toBe(2);
  });

  it('produces NO write for an already-clean actor (idempotent)', () => {
    const { update } = buildActorUpdate({
      id: 'actor-1',
      username: 'alice',
      summary: 'línea uno\n\nlínea dos',
      fields: [{ name: 'Web', value: 'carol.example' }],
    });
    expect(update.set).toEqual({});
    expect(update.unset).toEqual({});
  });
});

describe('describeChanges', () => {
  it('quotes both sides so the whitespace being removed is actually visible', async () => {
    const post = await seedRecord({
      content: { variants: [{ source: 'author', text: DIRTY_TEXT, tag: 'es' }] },
      federation: remote(),
    });
    const { update } = buildPostUpdate(post);

    expect(describeChanges(post, update)).toEqual([
      {
        path: 'content.variants.0.text',
        before: '"  uno   \\n   \\n   \\n  dos  "',
        after: '"uno\\n\\ndos"',
      },
    ]);
  });

  it('reads a value out of an array by index and reports a removal as (unset)', async () => {
    const post = await seedRecord({
      content: {
        variants: [{ source: 'author', text: CLEAN_TEXT, tag: 'es' }],
        media: [
          { id: 'file-a', type: 'image', alt: 'un gato' },
          { id: 'file-b', type: 'image', alt: ' \n ' },
        ],
      },
    });
    const { update } = buildPostUpdate(post);

    expect(describeChanges(post, update)).toEqual([
      { path: 'content.media.1.alt', before: '" \\n "', after: '(unset)' },
    ]);
  });
});

/** One dirty and one already-clean actor, as REAL rows. */
async function seedActors(): Promise<void> {
  await seedActor(scope, {
    uri: DIRTY_ACTOR_URI,
    username: '  alice\n ',
    acct: `alice@${scope.domain}`,
    summary: '  hola   \n  \n  \n  adiós ',
  });
  await seedActor(scope, {
    uri: CLEAN_ACTOR_URI,
    username: 'bob',
    acct: `bob@${scope.domain}`,
    summary: 'hola\n\nadiós',
  });
}

/**
 * A dirty federated post, a dirty native post and an already-clean one — the
 * shape a real run scans.
 */
async function seedScanPosts(): Promise<{ dirtyBody: string; dirtyLabels: string; clean: string }> {
  const dirtyBody = await seedRecord({
    content: { variants: [{ source: 'author', text: DIRTY_TEXT, tag: 'es' }] },
    federation: remote({ spoilerText: 'CW: spoilers' }),
  });
  const dirtyLabels = await seedRecord({
    content: {
      variants: [{ source: 'author', text: CLEAN_TEXT, tag: 'es' }],
      media: [
        { id: 'file-a', type: 'image', alt: 'un gato' },
        { id: 'file-b', type: 'image', alt: '  un perro\n ' },
      ],
    },
    federation: remote({ spoilerText: '  CW:\n  spoilers  ' }),
  });
  const clean = await seedRecord({
    content: { variants: [{ source: 'author', text: CLEAN_TEXT, tag: 'es' }] },
    federation: remote({ spoilerText: 'CW: spoilers' }),
  });
  return { dirtyBody: dirtyBody.id, dirtyLabels: dirtyLabels.id, clean: clean.id };
}

describe('normalizeStoredText — DRY RUN', () => {
  it('performs NO write at all', async () => {
    const seeded = await seedScanPosts();
    await seedActors();

    const summary = await normalizeStoredText(true);

    expect(summary.dryRun).toBe(true);
    expect(summary.posts.written).toBe(0);
    expect(summary.actors.written).toBe(0);
    // The dirty rows still hold their dirty text, on both sides.
    expect(await storedVariantBodies(seeded.dirtyBody)).toEqual([DIRTY_TEXT]);
    expect(await storedSpoilerText(seeded.dirtyLabels)).toBe('  CW:\n  spoilers  ');
    expect(await storedMediaAlts(seeded.dirtyLabels)).toEqual(['un gato', '  un perro\n ']);
    expect((await readActor(DIRTY_ACTOR_URI))?.username).toBe('  alice\n ');
  });

  it('reports the documents that WOULD change, not the ones it merely scanned', async () => {
    await seedScanPosts();
    await seedActors();

    const summary = await normalizeStoredText(true);

    // STRICTLY fewer changed than scanned, which is the distinction this test is
    // about. Neither absolute is pinned: both sweeps are GLOBAL by construction,
    // the rows are real, and vitest runs files in parallel against one database —
    // so another file's fixtures are legitimately in the scan.
    expect(summary.posts.changed).toBeGreaterThanOrEqual(2);
    expect(summary.posts.scanned).toBeGreaterThan(summary.posts.changed);
    expect(summary.actors.changed).toBe(1);
    expect(summary.actors.scanned).toBeGreaterThan(summary.actors.changed);
    expect(summary.actors.counts).toEqual({ username: 1, summary: 1, fields: 0 });
  });

  it('samples the real before/after values, whitespace visible', async () => {
    const seeded = await seedScanPosts();
    await seedActors();

    const summary = await normalizeStoredText(true);

    // The sample list is global and capped, so this file's post is LOOKED UP in
    // it rather than indexed by position.
    const sample = summary.posts.samples.find((entry) => entry.id === seeded.dirtyLabels);
    expect(sample?.changes).toEqual([
      { path: 'federation.spoilerText', before: '"  CW:\\n  spoilers  "', after: '"CW: spoilers"' },
      { path: 'content.media.1.alt', before: '"  un perro\\n "', after: '"un perro"' },
    ]);
    expect(summary.posts.samples.some((entry) => entry.id === seeded.clean)).toBe(false);

    expect(summary.actors.samples).toHaveLength(1);
    expect(summary.actors.samples[0].changes).toEqual([
      { path: 'username', before: '"  alice\\n "', after: '"alice"' },
      { path: 'summary', before: '"  hola   \\n  \\n  \\n  adiós "', after: '"hola\\n\\nadiós"' },
    ]);
  });
});

describe('normalizeStoredText — real run', () => {
  it('writes exactly what the dry run planned, and nothing on an already-clean row', async () => {
    const seeded = await seedScanPosts();
    await seedActors();

    // The plan for THIS file's rows, computed by the same builder the scan uses.
    const planned = await Promise.all(
      [seeded.dirtyBody, seeded.dirtyLabels, seeded.clean].map(async (id) => {
        const record = await loadPostRecord(id);
        return { id, update: buildPostUpdate(record as PostRecord).update };
      }),
    );
    const cleanBefore = await getDb()
      .select({ updatedAt: posts.updatedAt })
      .from(posts)
      .where(eq(posts.id, seeded.clean));

    await normalizeStoredText(false);

    expect(planned.find((entry) => entry.id === seeded.dirtyBody)?.update.set)
      .toEqual({ 'content.variants.0.text': CLEAN_TEXT });
    expect(await storedVariantBodies(seeded.dirtyBody)).toEqual([CLEAN_TEXT]);

    expect(await storedSpoilerText(seeded.dirtyLabels)).toBe('CW: spoilers');
    expect(await storedMediaAlts(seeded.dirtyLabels)).toEqual(['un gato', 'un perro']);

    // The clean post is not rewritten AT ALL — a rewrite of an already-clean row
    // is what makes a second run non-idempotent.
    const cleanAfter = await getDb()
      .select({ updatedAt: posts.updatedAt })
      .from(posts)
      .where(eq(posts.id, seeded.clean));
    expect(cleanAfter[0].updatedAt).toEqual(cleanBefore[0].updatedAt);
    expect(await storedVariantBodies(seeded.clean)).toEqual([CLEAN_TEXT]);

    // The dirty actor's ROW carries the normalized text, and the clean one is
    // byte-identical to what it was seeded with.
    expect(await readActor(DIRTY_ACTOR_URI)).toMatchObject({
      username: 'alice',
      summary: 'hola\n\nadiós',
    });
    expect(await readActor(CLEAN_ACTOR_URI)).toMatchObject({
      username: 'bob',
      summary: 'hola\n\nadiós',
    });
  });

  it('cleans the media alt of a NATIVE post while leaving its body alone', async () => {
    // Native rows are the reason the scan is no longer filtered on `federation`:
    // the composer's alt was stored verbatim, and the same raw value was signed
    // onto the author's MTN chain, where nothing can ever fix it. The stored row
    // — the one every read path actually serves — is what this cleans.
    const post = await seedRecord({
      content: {
        variants: [{ source: 'author', text: DIRTY_TEXT, tag: 'es' }],
        media: [{ id: 'file-a', type: 'image', alt: '  un gato\n  en una caja ' }],
      },
    });

    await normalizeStoredText(false);

    expect(await storedMediaAlts(post.id)).toEqual(['un gato en una caja']);
    expect(await storedVariantBodies(post.id)).toEqual([DIRTY_TEXT]);
  });

  it('nulls an alt that normalizes to nothing rather than blanking it', async () => {
    // `NULL` is what "absent" is for a column — the `$unset` that removed the key
    // from a document. An empty string would render as an alt badge with nothing
    // in it.
    const post = await seedRecord({
      content: {
        variants: [{ source: 'author', text: CLEAN_TEXT, tag: 'es' }],
        media: [{ id: 'file-a', type: 'image', alt: '  \n ' }],
      },
    });

    await normalizeStoredText(false);

    expect(await storedMediaAlts(post.id)).toEqual([null]);
  });

  it('finds nothing left to change on a second run', async () => {
    const seeded = await seedScanPosts();
    await seedActors();

    await normalizeStoredText(false);
    const second = await normalizeStoredText(true);

    expect(second.posts.samples.some((entry) => entry.id === seeded.dirtyBody)).toBe(false);
    expect(second.posts.samples.some((entry) => entry.id === seeded.dirtyLabels)).toBe(false);
    expect(second.actors.changed).toBe(0);
  });
});
