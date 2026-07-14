import mongoose from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The one-shot migration that moves every stored post onto the multilingual
 * content model: `content.variants[]` alone (the author's own body first, the
 * retired `translations[]` cache behind it as `source:'machine'`), and DROPS the
 * old `content.text` / `content.primaryTag` / `translations` fields.
 *
 * It runs in two PHASES, and the split is the whole point: the new code reads the
 * renditions ONLY, so a single pass that both wrote them AND deleted the old field
 * could not be deployed without a window of blank posts in either order. EXPAND
 * adds the renditions and touches nothing else (safe while the old code is live);
 * CONTRACT removes the retired fields (safe only once the new code is deployed).
 *
 * Three layers are covered:
 *
 *  - The pure update-builder, which holds every rule that matters: what becomes
 *    the primary variant, that a body with no resolvable language keeps an
 *    UNTAGGED rendition rather than being dropped or mislabelled, that an empty
 *    body (a boost) gets no rendition at all, that a machine translation into the
 *    author's OWN language is discarded, and that an already-migrated post
 *    produces no write (the idempotency the batch loop relies on to avoid
 *    rewriting 300k clean posts).
 *
 *  - The scan, over a canned model mock that honours the ascending-`_id` cursor.
 *    This is what proves the DRY RUN is real: it must issue NO write while still
 *    reporting exactly what a real run would do.
 *
 *  - **That the writes actually LAND.** The retired fields are no longer in the
 *    Post schema, and Mongoose casts update documents in strict mode — it
 *    silently STRIPS unknown paths, so a `$unset` of `content.text` issued through
 *    `Post.bulkWrite` would never reach Mongo while the script happily reported
 *    having removed it (the counters increment before the cast). The script
 *    therefore writes through the RAW driver, and the mock below deliberately
 *    exposes NO `Post.bulkWrite` at all: a regression back to the model would
 *    throw here rather than silently no-op in production.
 */

/** A canned row as the raw driver hands it back. */
interface StoredRow {
  _id: mongoose.Types.ObjectId;
  language?: unknown;
  createdAt?: unknown;
  type?: string;
  content?: { text?: unknown; primaryTag?: unknown; variants?: unknown };
  translations?: unknown;
}

/** The bulk op the script builds for one post. */
interface BulkOp {
  updateOne: {
    filter: { _id: mongoose.Types.ObjectId };
    update: { $set?: Record<string, unknown>; $unset?: Record<string, ''> };
  };
}

const h = vi.hoisted(() => {
  const state: {
    posts: StoredRow[];
    ops: BulkOp[];
    indexes: Array<{ name: string; key: Record<string, unknown> }>;
  } = {
    posts: [],
    ops: [],
    indexes: [],
  };

  const readPath = (doc: Record<string, unknown>, path: string): unknown => {
    let cursor: unknown = doc;
    for (const segment of path.split('.')) {
      if (cursor === null || typeof cursor !== 'object') return undefined;
      cursor = (cursor as Record<string, unknown>)[segment];
    }
    return cursor;
  };

  const writePath = (doc: Record<string, unknown>, path: string, value: unknown): void => {
    const segments = path.split('.');
    let cursor = doc;
    for (let i = 0; i < segments.length - 1; i++) {
      const key = segments[i];
      if (typeof cursor[key] !== 'object' || cursor[key] === null) cursor[key] = {};
      cursor = cursor[key] as Record<string, unknown>;
    }
    cursor[segments[segments.length - 1]] = value;
  };

  const deletePath = (doc: Record<string, unknown>, path: string): void => {
    const segments = path.split('.');
    let cursor: Record<string, unknown> | undefined = doc;
    for (let i = 0; i < segments.length - 1; i++) {
      const next = cursor?.[segments[i]];
      if (typeof next !== 'object' || next === null) return;
      cursor = next as Record<string, unknown>;
    }
    if (cursor) delete cursor[segments[segments.length - 1]];
  };

  /**
   * Serve one page the way the real cursor does: ascending `_id`, everything
   * strictly after the cursor, capped at the page size. Honouring `$gt` is what
   * lets the script's `for(;;)` loop terminate — a mock that ignored it would
   * hand back the same page forever.
   */
  const page = (filter: Record<string, unknown>, limit: number): StoredRow[] => {
    const cursor = (filter._id as { $gt?: mongoose.Types.ObjectId } | undefined)?.$gt;
    const after = cursor ? cursor.toString() : null;
    return [...state.posts]
      .sort((a, b) => a._id.toString().localeCompare(b._id.toString()))
      .filter((row) => after === null || row._id.toString() > after)
      .slice(0, limit);
  };

  return {
    state,
    estimatedDocumentCount: vi.fn(async () => state.posts.length),
    find: vi.fn((filter: Record<string, unknown>) => {
      let limit = Number.MAX_SAFE_INTEGER;
      const chain = {
        sort: () => chain,
        limit: (value: number) => {
          limit = value;
          return chain;
        },
        toArray: async () => page(filter, limit),
      };
      return chain;
    }),
    // APPLIES the ops to the in-memory store, so a later `countDocuments` sees
    // exactly what the run really did. That is what lets the verification test
    // below be a genuine re-read rather than a restatement of the counters.
    bulkWrite: vi.fn(async (ops: BulkOp[]) => {
      state.ops.push(...ops);
      for (const op of ops) {
        const doc = state.posts.find((p) => p._id.toString() === op.updateOne.filter._id.toString());
        if (!doc) continue;
        const target = doc as unknown as Record<string, unknown>;
        for (const [path, value] of Object.entries(op.updateOne.update.$set ?? {})) {
          writePath(target, path, value);
        }
        for (const path of Object.keys(op.updateOne.update.$unset ?? {})) {
          deletePath(target, path);
        }
      }
      return { modifiedCount: ops.length };
    }),
    // Supports the two shapes the script actually issues: `{ $exists }` and
    // `{ $regex }`, ANDed across keys. `content.variants.0` indexes the array, so
    // the dotted read has to walk into it — that is exactly how the real driver
    // decides whether a post has a rendition at all.
    countDocuments: vi.fn(async (filter: Record<string, { $exists?: boolean; $regex?: RegExp }>) => {
      return state.posts.filter((post) =>
        Object.entries(filter).every(([path, condition]) => {
          const value = readPath(post as unknown as Record<string, unknown>, path);
          if (condition.$regex !== undefined) {
            return typeof value === 'string' && condition.$regex.test(value);
          }
          return (value !== undefined) === (condition.$exists ?? true);
        }),
      ).length;
    }),
    indexes: vi.fn(async () => state.indexes),
    createIndex: vi.fn(async (keys: Record<string, unknown>, options: { name: string }) => {
      // Mirror MongoDB: an index with this name but a DIFFERENT key is a hard
      // error, not a silent redefinition. This is what makes the saved-posts swap
      // fail in production if the drop is skipped.
      const existing = state.indexes.find((index) => index.name === options.name);
      if (existing && JSON.stringify(existing.key) !== JSON.stringify(keys)) {
        throw new Error(`IndexKeySpecsConflict: ${options.name}`);
      }
      if (!existing) state.indexes.push({ name: options.name, key: keys });
      return options.name;
    }),
    dropIndex: vi.fn(async (name: string) => {
      state.indexes = state.indexes.filter((index) => index.name !== name);
    }),
  };
});

// NOTE the shape: `Post` exposes `estimatedDocumentCount` and `collection` — and
// deliberately NO `bulkWrite`/`find` of its own. The script must go through the
// raw driver, and this mock makes a regression fail loudly instead of silently.
vi.mock('../../models/Post', () => ({
  Post: {
    estimatedDocumentCount: h.estimatedDocumentCount,
    collection: {
      find: h.find,
      bulkWrite: h.bulkWrite,
      countDocuments: h.countDocuments,
      indexes: h.indexes,
      createIndex: h.createIndex,
      dropIndex: h.dropIndex,
    },
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  buildPostUpdate,
  migratePostVariants,
  swapBodyIndexes,
} from '../../scripts/migratePostContentVariants';

const oid = (suffix: string): mongoose.Types.ObjectId =>
  new mongoose.Types.ObjectId(`00000000000000000000000${suffix}`);

const OID = oid('1');
const CREATED_AT = new Date('2024-01-02T03:04:05.000Z');
const ISO = CREATED_AT.toISOString();

beforeEach(() => {
  h.state.posts = [];
  h.state.ops = [];
  h.state.indexes = [
    { name: 'content.text_text', key: { 'content.text': 'text' } },
    { name: 'saved_posts_text_idx', key: { _id: 1, 'content.text': 1 } },
  ];
  vi.clearAllMocks();
});

describe('EXPAND — writes the renditions, and NOTHING else', () => {
  it('turns the body + language into the primary author variant', () => {
    const { update } = buildPostUpdate(
      { _id: OID, language: 'es', createdAt: CREATED_AT, content: { text: 'hola mundo' } },
      'expand',
    );

    expect(update.set['content.variants']).toEqual([
      { tag: 'es', source: 'author', text: 'hola mundo', createdAt: ISO },
    ]);
  });

  it('LEAVES content.text and translations alone — that is what makes it safe to run under the old code', () => {
    // The currently-deployed code still reads these. Expand may only ADD a field
    // nothing yet looks at; the moment it removes one, running it against a live
    // production blanks posts.
    const { update } = buildPostUpdate(
      {
        _id: OID,
        language: 'es',
        createdAt: CREATED_AT,
        content: { text: 'hola', primaryTag: 'es' },
        translations: [{ language: 'en', text: 'hi', translatedAt: CREATED_AT }],
      },
      'expand',
    );

    expect(update.unset).toEqual({});
  });

  it('canonicalizes the stored language (`pt-br` → `pt-BR`) — no raw tag enters the model', () => {
    const { update } = buildPostUpdate(
      { _id: OID, language: 'pt-br', createdAt: CREATED_AT, content: { text: 'ola' } },
      'expand',
    );

    const variants = update.set['content.variants'] as Array<{ tag?: string }>;
    expect(variants[0].tag).toBe('pt-BR');
  });

  it('keeps the body as an UNTAGGED rendition when the language is not a usable tag', () => {
    // The body is still the post. Refusing to store it because we cannot name its
    // language would lose data to protect a field; minting a tag from a guess
    // would federate a lie. An untagged rendition is the honest third option.
    const { update, counts } = buildPostUpdate(
      { _id: OID, language: 'not a language', createdAt: CREATED_AT, content: { text: 'body' } },
      'expand',
    );

    expect(update.set['content.variants']).toEqual([
      { source: 'author', text: 'body', createdAt: ISO },
    ]);
    expect(counts.untagged).toBe(1);
    expect(counts.tagged).toBe(0);
    expect(counts.lostBody).toBe(0);
  });

  it('keeps the body as an UNTAGGED rendition when the post has no language at all', () => {
    const { update, counts } = buildPostUpdate(
      { _id: OID, createdAt: CREATED_AT, content: { text: 'ok' } },
      'expand',
    );

    expect(update.set['content.variants']).toEqual([{ source: 'author', text: 'ok', createdAt: ISO }]);
    expect(counts.untagged).toBe(1);
  });

  it('NEVER loses a body: every post with text comes out with a rendition holding it', () => {
    // The tripwire the run aborts on. Contract deletes `content.text` later, so a
    // body that failed to land in a rendition is gone for good.
    for (const language of ['es', 'not a language', undefined, '', 'zz-ZZ-invalid']) {
      const { update, counts } = buildPostUpdate(
        { _id: OID, language, createdAt: CREATED_AT, content: { text: 'a body that must survive' } },
        'expand',
      );

      const variants = update.set['content.variants'] as Array<{ text: string }>;
      expect(variants[0].text).toBe('a body that must survive');
      expect(counts.lostBody).toBe(0);
    }
  });

  it('gives an empty body (a boost) NO rendition — not an empty-string one', () => {
    const { update, counts } = buildPostUpdate(
      { _id: OID, language: 'en', createdAt: CREATED_AT, content: { text: '' } },
      'expand',
    );

    expect(update.set['content.variants']).toBeUndefined();
    expect(counts.lostBody).toBe(0);
  });

  it('carries each cached translation over as a machine variant', () => {
    const { update, counts } = buildPostUpdate(
      {
        _id: OID,
        language: 'es',
        createdAt: CREATED_AT,
        content: { text: 'hola' },
        translations: [
          { language: 'en', text: 'hi', translatedAt: new Date('2025-05-05T00:00:00.000Z') },
          { language: 'fr-fr', text: 'salut', translatedAt: new Date('2025-05-06T00:00:00.000Z') },
        ],
      },
      'expand',
    );

    expect(update.set['content.variants']).toEqual([
      { tag: 'es', source: 'author', text: 'hola', createdAt: ISO },
      { tag: 'en', source: 'machine', text: 'hi', createdAt: '2025-05-05T00:00:00.000Z' },
      { tag: 'fr-FR', source: 'machine', text: 'salut', createdAt: '2025-05-06T00:00:00.000Z' },
    ]);
    expect(counts.machineVariants).toBe(2);
  });

  it('drops a machine translation INTO the language the author already wrote in', () => {
    // One body per tag, and the author's own words always win over a machine's.
    const { update } = buildPostUpdate(
      {
        _id: OID,
        language: 'es',
        createdAt: CREATED_AT,
        content: { text: 'hola' },
        translations: [{ language: 'es', text: 'hola (traducido)', translatedAt: CREATED_AT }],
      },
      'expand',
    );

    expect(update.set['content.variants']).toEqual([
      { tag: 'es', source: 'author', text: 'hola', createdAt: ISO },
    ]);
  });

  it('writes NOTHING for an already-expanded post — this is what makes the second pass cheap', () => {
    // Step 3 of the deploy sequence re-runs expand over the whole collection to
    // catch posts created during the rollout. If an expanded post were rewritten,
    // that pass would be a second full 300k-document rewrite instead of a scan.
    const { update } = buildPostUpdate(
      {
        _id: OID,
        language: 'es',
        createdAt: CREATED_AT,
        content: {
          text: 'hola',
          variants: [{ tag: 'es', source: 'author', text: 'hola', createdAt: ISO }],
        },
      },
      'expand',
    );

    expect(update.set).toEqual({});
    expect(update.unset).toEqual({});
  });
});

describe('CONTRACT — removes the retired fields, and NOTHING else', () => {
  it('unsets content.text, content.primaryTag and translations', () => {
    const { update, counts } = buildPostUpdate(
      {
        _id: OID,
        language: 'es',
        createdAt: CREATED_AT,
        content: {
          text: 'hola',
          primaryTag: 'es',
          variants: [{ tag: 'es', source: 'author', text: 'hola', createdAt: ISO }],
        },
        translations: [{ language: 'en', text: 'hi', translatedAt: CREATED_AT }],
      },
      'contract',
    );

    expect(update.unset).toEqual({
      'content.text': '',
      'content.primaryTag': '',
      translations: '',
    });
    // It rewrites no renditions — expand already did, and re-deriving them here
    // could only disagree with what the live code has since written.
    expect(update.set).toEqual({});
    expect(counts.textRemoved).toBe(1);
    expect(counts.translationsRemoved).toBe(1);
  });

  it('REFUSES to unset a body that never made it into a rendition', () => {
    // THE guard. This post was missed by expand (or written by the old code after
    // it ran). Deleting `content.text` here destroys the body irrecoverably —
    // there is no other copy and no later run can rebuild it from a field that is
    // gone. It must be skipped and counted, not written.
    const { update, counts } = buildPostUpdate(
      { _id: OID, language: 'es', createdAt: CREATED_AT, content: { text: 'un cuerpo sin variante' } },
      'contract',
    );

    expect(update.unset).toEqual({});
    expect(update.set).toEqual({});
    expect(counts.notExpanded).toBe(1);
    expect(counts.textRemoved).toBe(0);
  });

  it('still contracts a boost (empty body, no rendition — nothing to lose)', () => {
    const { update, counts } = buildPostUpdate(
      { _id: OID, createdAt: CREATED_AT, content: { text: '' }, translations: [] },
      'contract',
    );

    expect(update.unset).toEqual({ 'content.text': '', translations: '' });
    expect(counts.notExpanded).toBe(0);
  });

  it('writes nothing for a post already fully contracted (idempotent)', () => {
    const { update } = buildPostUpdate(
      {
        _id: OID,
        language: 'es',
        createdAt: CREATED_AT,
        content: { variants: [{ tag: 'es', source: 'author', text: 'hola', createdAt: ISO }] },
      },
      'contract',
    );

    expect(update.set).toEqual({});
    expect(update.unset).toEqual({});
  });
});

describe('migratePostVariants — the scan', () => {
  it('DRY RUN issues no write at all, while reporting exactly what a real run would do', async () => {
    h.state.posts = [
      { _id: oid('1'), language: 'es', createdAt: CREATED_AT, content: { text: 'hola' } },
      { _id: oid('2'), language: 'en', createdAt: CREATED_AT, content: { text: 'hi' } },
      // Already expanded: must not be counted or written.
      {
        _id: oid('3'),
        language: 'en',
        createdAt: CREATED_AT,
        content: { text: 'done', variants: [{ tag: 'en', source: 'author', text: 'done' }] },
      },
    ];

    const summary = await migratePostVariants('expand', true);

    expect(h.bulkWrite).not.toHaveBeenCalled();
    expect(summary.scanned).toBe(3);
    expect(summary.changed).toBe(2);
    expect(summary.written).toBe(0);
    expect(summary.counts.authorVariant).toBe(2);
  });

  it('EXPAND leaves the retired fields in place — they are still there afterwards, by design', async () => {
    h.state.posts = [
      { _id: oid('1'), language: 'es', createdAt: CREATED_AT, content: { text: 'hola' } },
    ];

    const summary = await migratePostVariants('expand', false);

    expect(summary.written).toBe(1);
    expect(h.state.ops[0].updateOne.update.$unset).toBeUndefined();
    // The old code is still live and still reading this.
    expect(summary.leftovers.text).toBe(1);
    const content = h.state.posts[0].content as { text: string; variants: Array<{ text: string }> };
    expect(content.text).toBe('hola');
    expect(content.variants[0].text).toBe('hola');
  });
});

describe('the full deploy sequence: expand → deploy → expand → contract', () => {
  it('the SECOND expand catches a post the old code wrote during the rollout window', async () => {
    h.state.posts = [
      { _id: oid('1'), language: 'es', createdAt: CREATED_AT, content: { text: 'hola' } },
    ];

    await migratePostVariants('expand', false);

    // …the deploy rolls out, and mid-rollout an instance still running the OLD
    // code writes a post the only way it knows how: body in `content.text`.
    h.state.posts.push({
      _id: oid('9'),
      language: 'en',
      createdAt: CREATED_AT,
      content: { text: 'written by the old code' },
    });

    // Contract now would destroy it — and refuses to run at all.
    await expect(migratePostVariants('contract', false)).rejects.toThrow(/CONTRACT would DESTROY them/);

    // The second expand is what makes the window safe.
    await migratePostVariants('expand', false);
    const rescued = h.state.posts[1].content as { variants: Array<{ text: string }> };
    expect(rescued.variants[0].text).toBe('written by the old code');

    // And now contract is safe.
    const summary = await migratePostVariants('contract', false);
    expect(summary.leftovers).toEqual({ text: 0, primaryTag: 0, translations: 0 });
  });

  it('contract re-reads the collection and proves the retired fields are gone', async () => {
    // The counters increment while the update is being BUILT, so they would report
    // a clean sweep even if every `$unset` were discarded on the way out — which is
    // exactly what Mongoose's strict-mode cast does to a path the schema no longer
    // declares. Only a re-read can tell the truth.
    h.state.posts = [
      {
        _id: oid('1'),
        language: 'es',
        createdAt: CREATED_AT,
        content: { text: 'hola', primaryTag: 'es' },
        translations: [{ language: 'en', text: 'hi', translatedAt: CREATED_AT }],
      },
    ];

    await migratePostVariants('expand', false);
    const summary = await migratePostVariants('contract', false);

    expect(summary.leftovers).toEqual({ text: 0, primaryTag: 0, translations: 0 });
    const content = h.state.posts[0].content as { text?: unknown; variants: Array<{ text: string }> };
    expect(content.text).toBeUndefined();
    expect(content.variants[0].text).toBe('hola');
  });

  it('contract ABORTS when the retired fields survive the write (the silent-strip failure)', async () => {
    h.state.posts = [
      {
        _id: oid('1'),
        language: 'es',
        createdAt: CREATED_AT,
        content: { text: 'hola', variants: [{ tag: 'es', source: 'author', text: 'hola' }] },
      },
    ];

    // Simulate exactly what `Post.bulkWrite` would have done: silently drop the
    // `$unset` of a path the schema no longer declares.
    h.bulkWrite.mockImplementationOnce(async (ops: BulkOp[]) => ({ modifiedCount: ops.length }));

    await expect(migratePostVariants('contract', false)).rejects.toThrow(/STILL PRESENT/);
  });
});

describe('swapBodyIndexes — the indexes follow the body', () => {
  it('drops the full-text index over the old body and creates the multikey one over the renditions', async () => {
    await swapBodyIndexes(false);

    expect(h.dropIndex).toHaveBeenCalledWith('content.text_text');
    expect(h.createIndex).toHaveBeenCalledWith(
      { 'content.variants.text': 'text' },
      expect.objectContaining({
        name: 'content.variants.text_text',
        // The error-17262 guard: the override stays pinned to a sentinel field no
        // document populates, so MongoDB never reads a content-language code as a
        // stemmer override.
        language_override: 'textSearchLanguage',
      }),
    );
  });

  it('drops and RECREATES saved_posts_text_idx — same name, different key', async () => {
    // The nastier of the two. The schema re-declares this index under the SAME
    // name with a new key, and MongoDB rejects that outright rather than
    // redefining it — so a deploy alone does not fix production. Without the drop,
    // the create throws IndexKeySpecsConflict and the stale index (pointing at a
    // field no document has) survives.
    await swapBodyIndexes(false);

    expect(h.dropIndex).toHaveBeenCalledWith('saved_posts_text_idx');
    expect(h.createIndex).toHaveBeenCalledWith(
      { _id: 1, 'content.variants.text': 1 },
      { name: 'saved_posts_text_idx' },
    );
  });

  it('would FAIL to create the saved-posts index if the drop were skipped', async () => {
    // Pins the reason the drop exists: creating it over the stale one is an error,
    // not an update. If someone "simplifies" the drop away, this is what happens.
    await expect(
      h.createIndex({ _id: 1, 'content.variants.text': 1 }, { name: 'saved_posts_text_idx' }),
    ).rejects.toThrow(/IndexKeySpecsConflict/);
  });

  it('writes no index change on a DRY RUN', async () => {
    await swapBodyIndexes(true);

    expect(h.dropIndex).not.toHaveBeenCalled();
    expect(h.createIndex).not.toHaveBeenCalled();
  });

  it('is idempotent: a re-run with both indexes already migrated does nothing', async () => {
    h.state.indexes = [
      { name: 'content.variants.text_text', key: { 'content.variants.text': 'text' } },
      { name: 'saved_posts_text_idx', key: { _id: 1, 'content.variants.text': 1 } },
    ];

    await swapBodyIndexes(false);

    expect(h.dropIndex).not.toHaveBeenCalled();
    expect(h.createIndex).not.toHaveBeenCalled();
  });
});
