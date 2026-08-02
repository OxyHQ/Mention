import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closePostgres, connectPostgres } from '../../db/postgres';
import {
  clearFederationScope,
  federationScope,
  readActor,
  seedActor,
} from '../helpers/federationFixtures';

const scope = federationScope('normalize-federated-text');
const DIRTY_ACTOR_URI = `${scope.origin}/users/alice`;
const CLEAN_ACTOR_URI = `${scope.origin}/users/bob`;

/**
 * The one-shot backfill that cleans the remote text ALREADY stored in Mongo.
 *
 * Two layers are covered:
 *
 *  - The pure update-builders, which hold every rule that matters: which helper
 *    each field gets, that an emptied optional label is UNSET rather than
 *    blanked, that a required field is never emptied, and that a document with
 *    nothing to fix produces no write at all (the idempotency the batch loop
 *    relies on to avoid rewriting hundreds of thousands of clean posts).
 *
 *  - The scan itself, over canned `Post` / `FederatedActor` model mocks that
 *    honour the script's ascending-`_id` cursor. This is what proves the DRY RUN
 *    is real: it must issue NO `bulkWrite` at all, while still reporting exactly
 *    the documents a real run would rewrite.
 */

/** A canned row as the models hand it to the script (`.lean()` output). */
interface StoredRow {
  _id: mongoose.Types.ObjectId;
  content?: { variants?: unknown; media?: unknown };
  federation?: { spoilerText?: unknown };
  username?: unknown;
  summary?: unknown;
  fields?: unknown;
}

/** The bulk op the script builds for one dirty document. */
interface BulkOp {
  updateOne: {
    filter: { _id: mongoose.Types.ObjectId };
    update: { $set?: Record<string, unknown>; $unset?: Record<string, ''> };
  };
}

/** The `find(...).sort(...).limit(...).lean()` chain the script calls. */
interface FindChain {
  sort: () => FindChain;
  limit: (value: number) => FindChain;
  lean: () => Promise<StoredRow[]>;
}

const h = vi.hoisted(() => {
  const state: {
    posts: StoredRow[];
    actors: StoredRow[];
    postOps: BulkOp[];
    actorOps: BulkOp[];
  } = { posts: [], actors: [], postOps: [], actorOps: [] };

  /**
   * Serve one page the way the real cursor does: ascending `_id`, everything
   * strictly after the cursor, capped at the page size. Honouring `$gt` is what
   * lets the script's `for(;;)` loop terminate — a mock that ignored it would
   * hand back the same page forever.
   */
  const page = (rows: StoredRow[], filter: Record<string, unknown>, limit: number): StoredRow[] => {
    const cursor = (filter._id as { $gt?: mongoose.Types.ObjectId } | undefined)?.$gt;
    const after = cursor ? cursor.toString() : null;
    return [...rows]
      .sort((a, b) => a._id.toString().localeCompare(b._id.toString()))
      .filter((row) => after === null || row._id.toString() > after)
      .slice(0, limit);
  };

  const makeFind = (rows: () => StoredRow[]) =>
    vi.fn((filter: Record<string, unknown>) => {
      let limit = Number.MAX_SAFE_INTEGER;
      const chain: FindChain = {
        sort: () => chain,
        limit: (value: number) => {
          limit = value;
          return chain;
        },
        lean: async () => page(rows(), filter, limit),
      };
      return chain;
    });

  return {
    state,
    postCount: vi.fn(async () => state.posts.length),
    postFind: makeFind(() => state.posts),
    postBulkWrite: vi.fn(async (ops: BulkOp[]) => {
      state.postOps.push(...ops);
      return { modifiedCount: ops.length };
    }),
  };
});

vi.mock('../../models/Post', () => ({
  Post: { countDocuments: h.postCount, find: h.postFind, bulkWrite: h.postBulkWrite },
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// The invariant test below drives the REAL ingest extractor. Only its media
// materialization (network + S3) is mocked away; the text rules are the real ones.
vi.mock('../../connectors/shared/federatedMedia', () => ({
  materializeFederatedMedia: vi.fn(async (media: unknown[], attachments: unknown[]) => ({ media, attachments })),
}));

import {
  buildActorUpdate,
  buildPostUpdate,
  describeChanges,
  normalizeStoredText,
} from '../../scripts/normalizeFederatedText';
import { extractApSummary } from '../../connectors/activitypub/apPostContent';
import { normalizeAlt } from '../../services/MediaMetadataService';

/** The `_id` of the row under test — the builders only echo it into the filter. */
const OID = new mongoose.Types.ObjectId('000000000000000000000001');

const oid = (suffix: string): mongoose.Types.ObjectId =>
  new mongoose.Types.ObjectId(`00000000000000000000000${suffix}`);

/** The body of a pretty-printed remote post: padded, with a padded blank line. */
const DIRTY_TEXT = '  uno   \n   \n   \n  dos  ';
const CLEAN_TEXT = 'uno\n\ndos';

describe('buildPostUpdate', () => {
  it('normalizes the body as multiline, keeping the author’s paragraph break', () => {
    const { update, counts } = buildPostUpdate({
      _id: OID,
      content: { variants: [{ source: 'author', text: DIRTY_TEXT }] },
      // A federated post with no content warning: `federation` is PRESENT, which
      // is what makes the body eligible.
      federation: {},
    });

    expect(update.set['content.variants.0.text']).toBe(CLEAN_TEXT);
    expect(update.unset).toEqual({});
    expect(counts.text).toBe(1);
  });

  it('never rewrites the body of a NATIVE post — that text is the local author’s', () => {
    // The scan covers every post now (native alt is dirty too), so what a row IS
    // has to decide which of its fields are eligible.
    const { update, counts } = buildPostUpdate({
      _id: OID,
      content: {
        variants: [{ source: 'author', text: DIRTY_TEXT }],
        media: [{ id: 'a', type: 'image', alt: '  un gato\n  en una caja ' }],
      },
    });

    expect(update.set).toEqual({ 'content.media.0.alt': 'un gato en una caja' });
    expect(counts).toEqual({ text: 0, spoilerText: 0, mediaAlt: 1 });
  });

  it('normalizes the content warning as inline text', () => {
    const { update, counts } = buildPostUpdate({
      _id: OID,
      federation: { spoilerText: '  CW:\n  spoilers  ' },
    });

    expect(update.set['federation.spoilerText']).toBe('CW: spoilers');
    expect(counts.spoilerText).toBe(1);
  });

  it('STRIPS THE MARKUP of a content warning the old ingest stored raw', () => {
    // The ingest that wrote these rows persisted the AP `summary` verbatim, and a
    // Mastodon summary arrives as HTML on plenty of servers. A backfill that only
    // collapsed whitespace would leave `<p>…</p>` in the database forever.
    const { update, counts } = buildPostUpdate({
      _id: OID,
      federation: { spoilerText: '<p>\n  Spoilers de <strong>la peli</strong>\n</p>' },
    });

    expect(update.set['federation.spoilerText']).toBe('Spoilers de la peli');
    expect(counts.spoilerText).toBe(1);
  });

  it('UNSETS a content warning and an alt that normalize to nothing', () => {
    // These are optional labels read as "present ⇒ show it", so a value that
    // normalizes away must disappear, not become an empty string.
    const { update } = buildPostUpdate({
      _id: OID,
      federation: { spoilerText: '   \n  ' },
      content: { media: [{ id: 'a', type: 'image', alt: '  \n ' }] },
    });

    expect(update.unset).toEqual({
      'federation.spoilerText': '',
      'content.media.0.alt': '',
    });
    expect(update.set['federation.spoilerText']).toBeUndefined();
  });

  it('addresses media alt by index so the item’s other fields are never rewritten', () => {
    const { update, counts } = buildPostUpdate({
      _id: OID,
      content: {
        media: [
          { id: 'a', type: 'image', alt: 'ya limpio' },
          { id: 'b', type: 'image', width: 100, alt: '  un gato\n  en una caja ' },
        ],
      },
    });

    // Only the dirty item's `alt` path is written — `content.media` as a whole
    // is never re-serialized, so `id`/`type`/`width` cannot be lost.
    expect(update.set).toEqual({ 'content.media.1.alt': 'un gato en una caja' });
    expect(counts.mediaAlt).toBe(1);
  });

  it('produces NO write for an already-clean post (idempotent)', () => {
    const clean = {
      _id: OID,
      content: {
        variants: [{ source: 'author', text: CLEAN_TEXT }],
        media: [{ id: 'a', type: 'image', alt: 'un gato' }],
      },
      federation: { spoilerText: 'CW: spoilers' },
    };
    const { update } = buildPostUpdate(clean);
    expect(update.set).toEqual({});
    expect(update.unset).toEqual({});
  });

  it('leaves a non-string stored value alone', () => {
    // The script normalizes whitespace; it does not repair a corrupt schema.
    const { update } = buildPostUpdate({
      _id: OID,
      content: { variants: [{ source: 'author', text: 42 }], media: 'not-an-array' },
      federation: { spoilerText: { nested: true } },
    });
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
    '',
  ];

  it.each(STORED_SUMMARIES)('spoilerText: %j lands on exactly what the ingest extracts', (stored) => {
    // What the ingest would write for this value if the Note arrived again today.
    const ingested = extractApSummary({ summary: stored });

    const { update } = buildPostUpdate({ _id: OID, federation: { spoilerText: stored } });

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

  it.each(STORED_ALTS)('media alt: %j lands on exactly what the alt rule produces', (stored) => {
    const canonical = normalizeAlt(stored);

    const { update } = buildPostUpdate({
      _id: OID,
      content: { media: [{ id: 'a', type: 'image', alt: stored }] },
    });

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
      _id: OID,
      username: '  alice\n ',
      summary: '  línea uno   \n  \n  \n  línea dos ',
    });

    expect(update.set.username).toBe('alice');
    expect(update.set.summary).toBe('línea uno\n\nlínea dos');
    expect(counts.username).toBe(1);
    expect(counts.summary).toBe(1);
  });

  it('never empties the username — it is required and half of a unique index', () => {
    const { update, counts } = buildActorUpdate({ _id: OID, username: '   \n ' });
    expect(update.set.username).toBeUndefined();
    expect(counts.username).toBe(0);
  });

  it('normalizes profile fields by index, preserving the untouched entries', () => {
    const { update, counts } = buildActorUpdate({
      _id: OID,
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
      _id: OID,
      username: 'alice',
      summary: 'línea uno\n\nlínea dos',
      fields: [{ name: 'Web', value: 'carol.example' }],
    });
    expect(update.set).toEqual({});
    expect(update.unset).toEqual({});
  });
});

describe('describeChanges', () => {
  it('quotes both sides so the whitespace being removed is actually visible', () => {
    const post = {
      _id: OID,
      content: { variants: [{ source: 'author', text: DIRTY_TEXT }] },
      federation: {},
    };
    const { update } = buildPostUpdate(post);

    expect(describeChanges(post, update)).toEqual([
      {
        path: 'content.variants.0.text',
        before: '"  uno   \\n   \\n   \\n  dos  "',
        after: '"uno\\n\\ndos"',
      },
    ]);
  });

  it('reads a value out of an array by index and reports a removal as (unset)', () => {
    const post = {
      _id: OID,
      content: { media: [{ id: 'a', type: 'image', alt: 'un gato' }, { id: 'b', alt: ' \n ' }] },
    };
    const { update } = buildPostUpdate(post);

    expect(describeChanges(post, update)).toEqual([
      { path: 'content.media.1.alt', before: '" \\n "', after: '(unset)' },
    ]);
  });
});

/** Two dirty posts and one already-clean post — the shape a real run scans. */
function seedPosts(): void {
  h.state.posts = [
    // Dirty: a padded, pretty-printed body.
    { _id: oid('1'), content: { variants: [{ source: 'author', text: DIRTY_TEXT }] }, federation: { spoilerText: 'CW: spoilers' } },
    // Dirty: a padded content warning plus a padded alt on the second media item.
    {
      _id: oid('2'),
      content: {
        variants: [{ source: 'author', text: CLEAN_TEXT }],
        media: [
          { id: 'a', type: 'image', alt: 'un gato' },
          { id: 'b', type: 'image', alt: '  un perro\n ' },
        ],
      },
      federation: { spoilerText: '  CW:\n  spoilers  ' },
    },
    // Clean: must produce no write on either a dry or a real run.
    { _id: oid('3'), content: { variants: [{ source: 'author', text: CLEAN_TEXT }] }, federation: { spoilerText: 'CW: spoilers' } },
  ];
}

/** One dirty actor and one already-clean actor, as REAL rows. */
async function seedActors(): Promise<void> {
  await clearFederationScope(scope);
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

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  await clearFederationScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(async () => {
  h.state.posts = [];
  h.state.postOps = [];
  h.postBulkWrite.mockClear();
  h.postFind.mockClear();
  await clearFederationScope(scope);
});

describe('normalizeStoredText — DRY RUN', () => {
  it('performs NO write at all', async () => {
    seedPosts();
    await seedActors();

    await normalizeStoredText(true);

    expect(h.postBulkWrite).not.toHaveBeenCalled();
    expect(h.state.postOps).toHaveLength(0);
    // Nothing was rewritten: the dirty actor still holds its dirty text.
    expect((await readActor(DIRTY_ACTOR_URI))?.username).toBe('  alice\n ');
  });

  it('reports the documents that WOULD change — not the ones it merely scanned', async () => {
    seedPosts();
    await seedActors();

    const summary = await normalizeStoredText(true);

    expect(summary.dryRun).toBe(true);

    // 3 posts seen, only 2 of them dirty; nothing written.
    expect(summary.posts.scanned).toBe(3);
    expect(summary.posts.changed).toBe(2);
    expect(summary.posts.written).toBe(0);
    // The per-field breakdown counts VALUES, so the second post contributes both
    // its content warning and its one dirty media alt.
    expect(summary.posts.counts).toEqual({ text: 1, spoilerText: 1, mediaAlt: 1 });

    // 1 dirty actor (username + bio), and STRICTLY fewer changed than scanned —
    // which is the distinction this test is about.
    //
    // `scanned` is deliberately not pinned to an absolute. The actor sweep is
    // GLOBAL by construction (it normalizes every row in the table), the rows are
    // real, and vitest runs files in parallel against one database — so another
    // file's fixtures are legitimately in the scan. `changed` stays exact because
    // no other suite seeds text that normalizes to something different.
    expect(summary.actors.changed).toBe(1);
    expect(summary.actors.scanned).toBeGreaterThan(summary.actors.changed);
    expect(summary.actors.written).toBe(0);
    expect(summary.actors.counts).toEqual({ username: 1, summary: 1, fields: 0 });
  });

  it('samples the real before/after values, whitespace visible', async () => {
    seedPosts();
    await seedActors();

    const summary = await normalizeStoredText(true);

    expect(summary.posts.samples).toHaveLength(2);
    expect(summary.posts.samples[0]).toEqual({
      id: oid('1').toString(),
      changes: [
        {
          path: 'content.variants.0.text',
          before: '"  uno   \\n   \\n   \\n  dos  "',
          after: '"uno\\n\\ndos"',
        },
      ],
    });
    expect(summary.posts.samples[1].changes).toEqual([
      { path: 'federation.spoilerText', before: '"  CW:\\n  spoilers  "', after: '"CW: spoilers"' },
      { path: 'content.media.1.alt', before: '"  un perro\\n "', after: '"un perro"' },
    ]);

    expect(summary.actors.samples).toHaveLength(1);
    expect(summary.actors.samples[0].changes).toEqual([
      { path: 'username', before: '"  alice\\n "', after: '"alice"' },
      { path: 'summary', before: '"  hola   \\n  \\n  \\n  adiós "', after: '"hola\\n\\nadiós"' },
    ]);
  });

  it('finds nothing to change on a second (already-normalized) run', async () => {
    h.state.posts = [{ _id: oid('1'), content: { variants: [{ source: 'author', text: CLEAN_TEXT }] } }];
    await clearFederationScope(scope);
    await seedActor(scope, {
      uri: DIRTY_ACTOR_URI,
      username: 'alice',
      acct: `alice@${scope.domain}`,
      summary: 'hola\n\nadiós',
    });

    const summary = await normalizeStoredText(true);

    expect(summary.posts.scanned).toBe(1);
    expect(summary.posts.changed).toBe(0);
    expect(summary.actors.changed).toBe(0);
    expect(summary.posts.samples).toEqual([]);
  });
});

describe('normalizeStoredText — real run', () => {
  it('writes exactly the dirty documents, and the dry-run plan matches what it wrote', async () => {
    seedPosts();
    await seedActors();

    const planned = await normalizeStoredText(true);

    seedPosts();
    await seedActors();
    const applied = await normalizeStoredText(false);

    // What the dry run said would change is what the real run actually wrote.
    expect(applied.posts.written).toBe(planned.posts.changed);
    expect(applied.actors.written).toBe(planned.actors.changed);
    expect(applied.dryRun).toBe(false);

    // Only the two dirty posts are touched — the clean one gets no op at all.
    expect(h.state.postOps).toHaveLength(2);
    expect(h.state.postOps.map((op) => op.updateOne.filter._id.toString())).toEqual([
      oid('1').toString(),
      oid('2').toString(),
    ]);
    expect(h.state.postOps[1].updateOne.update.$set).toEqual({
      'federation.spoilerText': 'CW: spoilers',
      'content.media.1.alt': 'un perro',
    });

    // The dirty actor's ROW carries the normalized text, and the clean one is
    // byte-identical to what it was seeded with — a rewrite of an already-clean
    // row is the thing that makes a second run non-idempotent.
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
    // onto the author's MTN chain, where nothing can ever fix it. The Mongo row —
    // the one every read path actually serves — is what this cleans.
    h.state.posts = [
      {
        _id: oid('1'),
        content: {
          variants: [{ source: 'author', text: DIRTY_TEXT }],
          media: [{ id: 'a', type: 'image', alt: '  un gato\n  en una caja ' }],
        },
      },
    ];

    const summary = await normalizeStoredText(false);

    expect(summary.posts.counts).toEqual({ text: 0, spoilerText: 0, mediaAlt: 1 });
    expect(h.state.postOps).toHaveLength(1);
    expect(h.state.postOps[0].updateOne.update.$set).toEqual({
      'content.media.0.alt': 'un gato en una caja',
    });
  });

  it('unsets an alt that normalizes to nothing rather than blanking it', async () => {
    h.state.posts = [
      {
        _id: oid('1'),
        content: {
          variants: [{ source: 'author', text: CLEAN_TEXT }],
          media: [{ id: 'a', alt: '  \n ' }],
        },
      },
    ];

    await normalizeStoredText(false);

    expect(h.state.postOps).toHaveLength(1);
    expect(h.state.postOps[0].updateOne.update.$unset).toEqual({ 'content.media.0.alt': '' });
    expect(h.state.postOps[0].updateOne.update.$set).toBeUndefined();
  });
});
