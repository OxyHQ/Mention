/**
 * One-shot migration: move every post onto the multilingual content model.
 *
 * A post used to have ONE body (`content.text`), one language (`language`), and a
 * SEPARATE cache of AI translations (`Post.translations[]`). It now has a single
 * array of localized renditions — `content.variants[]` — holding the author's own
 * writing and the machine translations alike, with `variants[0]` as the primary.
 *
 * **`content.text` is DELETED, not kept as a mirror.** A denormalized copy is only
 * as good as the writers that maintain it, and one of ours cannot: the federated
 * outbox backfill inserts through `Post.collection.insertMany`, which bypasses
 * Mongoose middleware entirely, so a hook-maintained mirror would silently drift
 * on exactly that path. There is no read-time fallback to the old field anywhere
 * in the codebase, so the old rows are MIGRATED, not accommodated:
 *
 *   - `content.variants[0]` ← the primary AUTHOR variant: the body from
 *                             `content.text`, tagged with the post's `language`
 *                             canonicalized to BCP-47 (`pt-br` → `pt-BR`).
 *   - `content.variants[…]` ← each `translations[]` entry as `source:'machine'`.
 *   - `content.text`        ← REMOVED.
 *   - `content.primaryTag`  ← REMOVED (it was a copy of `variants[0].tag`).
 *   - `translations`        ← REMOVED.
 *
 * Rules that fall out of the content model (and are enforced here):
 *  - A post with an EMPTY body (a boost) gets NO variant. There is no rendition,
 *    in any language — an empty-string variant would be a lie about what is there.
 *  - A post whose language never resolved gets an UNTAGGED variant. This is a real
 *    and COMMON state (a body too short for the detector — "ok", "+1", a bare URL
 *    — or a federated Note that declared no language), not an error. The body is
 *    still the post and must be kept. Minting a tag from a detector's best guess
 *    would stamp a wrong language on it and then federate that lie onward in
 *    ActivityPub's `contentMap`/`language`. `untagged` in the summary counts these
 *    and is EXPECTED to be non-zero.
 *  - A machine translation INTO the author's own language is dropped — the author
 *    already wrote that body, and a variant holds one body per tag.
 *  - Posts already carrying author variants keep them; only their missing pieces
 *    are filled in. Re-running writes nothing.
 *
 * THE INDEXES move with the body, in the CONTRACT phase ({@link swapBodyIndexes})
 * — production runs with `autoIndex` off, so nothing else will move them:
 *   - the full-text index `content.text_text` → `content.variants.text_text`
 *     (multikey: it now matches ANY rendition of a post, not just its primary), and
 *   - the compound `saved_posts_text_idx`, whose NAME is unchanged but whose KEY
 *     moved — MongoDB rejects a same-name/different-key `createIndex` outright, so
 *     it must be dropped by name and recreated.
 * `language_override` still points at the sentinel field `textSearchLanguage`: the
 * variant subdoc's language field is called `tag`, not `language`, so MongoDB's
 * error-17262 trap ("language override unsupported") stays avoided.
 *
 * Idempotent, batched through a stable ascending `_id` cursor with `bulkWrite`
 * (the collection is never loaded into memory), and it only writes the documents
 * that actually change.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * TWO PHASES, AND WHY — READ THIS BEFORE RUNNING ANYTHING
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The new code reads the renditions ONLY. There is deliberately no fallback to
 * `content.text` — that dual read path is precisely what this change deletes. So
 * a single pass that both wrote the renditions AND removed the old field could
 * not be deployed without a window of blank posts, in EITHER order:
 *
 *   deploy, then migrate → every existing post renders blank until the migration
 *                          catches up.
 *   migrate, then deploy → every post created in between is written by the OLD
 *                          code (body in `content.text`, no renditions) and
 *                          renders blank forever after the deploy.
 *
 * The fix is expand/contract, not a compatibility shim:
 *
 *   PHASE=expand    Write `content.variants`. Leave `content.text` and
 *                   `translations` exactly as they are. Safe to run against
 *                   production while the OLD code is live: it only ADDS a field
 *                   that nothing yet reads. Idempotent — a post that already has
 *                   its renditions produces no write at all.
 *
 *   PHASE=contract  Delete `content.text`, `content.primaryTag` and
 *                   `translations`, and move the indexes. Safe ONLY once the new
 *                   code is fully deployed and nothing reads them. REFUSES to run
 *                   (and refuses to touch any individual post) while any body
 *                   still lives only in `content.text`.
 *
 * THE SEQUENCE — all four steps, in order:
 *
 *   1. PHASE=expand    (old code live; posts gain renditions, nothing breaks)
 *   2. deploy the new code
 *   3. PHASE=expand    AGAIN — this is the step people skip, and it is the one
 *                      that makes the window safe. Posts created between step 1
 *                      and the end of the rollout were written by the old code and
 *                      have no renditions; this catches them. Cheap: everything
 *                      already expanded is skipped without a write.
 *   4. PHASE=contract  (the old fields go; indexes swap)
 *
 * After step 4, `content.text` and `translations` exist nowhere in the codebase
 * except this script — and this script should then be DELETED, as the
 * collaborative-posts backfill was after it ran.
 *
 * DRY RUN
 * -------
 * This rewrites the content of every post in production (300k+), so run each phase
 * dry FIRST. `DRY_RUN=true` scans the same documents and builds the same updates
 * but performs NO `bulkWrite` and NO index change. It reports how many documents
 * WOULD change, the per-field breakdown, and a bounded sample. Same convention as
 * the sibling backfills in this directory.
 *
 * Run — as a Fargate one-shot against the deployed backend image (command
 * overridden), or locally with the same env:
 *   DRY_RUN=true PHASE=expand   bun packages/backend/dist/src/scripts/migratePostContentVariants.js
 *   PHASE=expand                bun packages/backend/dist/src/scripts/migratePostContentVariants.js
 *   DRY_RUN=true PHASE=contract bun packages/backend/dist/src/scripts/migratePostContentVariants.js
 *   PHASE=contract              bun packages/backend/dist/src/scripts/migratePostContentVariants.js
 *
 * Env:
 *   MONGODB_URI   the cluster (injected by ECS from SSM)
 *   NODE_ENV      selects the database (`mention-<NODE_ENV>`)
 *   PHASE         `expand` | `contract` — REQUIRED, no default
 *   DRY_RUN=true  plan only, no writes
 */

import mongoose from 'mongoose';
import type { AnyBulkWriteOperation } from 'mongodb';
import {
  MAX_AUTHOR_VARIANTS,
  canonicalizeLanguageTag,
  type PostContentVariant,
} from '@mention/shared-types';
import { Post } from '../models/Post';
import { logger } from '../utils/logger';

/**
 * The two halves of an expand/contract migration.
 *
 * They are separate RUNS, not two steps of one run, because a deploy happens
 * between them. See the header for the full sequence.
 */
export type MigrationPhase = 'expand' | 'contract';

/** Documents scanned per page (stable `_id` cursor pagination). */
const PAGE_SIZE = 500;

/** Updates flushed per `bulkWrite` chunk. */
const BULK_CHUNK_SIZE = 500;

/** How many changed documents a dry run reports in full. */
const DRY_RUN_SAMPLE_SIZE = 20;

/** One entry of the retired `Post.translations[]` cache. */
interface LegacyTranslation {
  language?: unknown;
  text?: unknown;
  translatedAt?: unknown;
}

/** The fields this script reads off a post (nothing else is loaded). */
export interface PostVariantRow {
  _id: mongoose.Types.ObjectId;
  language?: unknown;
  createdAt?: unknown;
  content?: {
    text?: unknown;
    primaryTag?: unknown;
    variants?: unknown;
  };
  translations?: unknown;
}

/** Per-field tally of what this run wrote (or would write). */
export interface MigrationCounts {
  /** Posts that gained their primary AUTHOR variant. */
  authorVariant: number;
  /** …of which carry a language tag. */
  tagged: number;
  /** …of which are UNTAGGED (no language could be resolved). Expect a real number here. */
  untagged: number;
  /** Machine variants carried over from `translations[]`. */
  machineVariants: number;
  /** Posts whose body was removed from the retired `content.text`. */
  textRemoved: number;
  /** Posts whose retired `translations` field was removed. */
  translationsRemoved: number;
  /**
   * TRIPWIRE — posts that HAD a body and came out with no rendition to put it in.
   * Impossible by construction (a body with no resolvable language still gets an
   * UNTAGGED variant), so a non-zero value here means the script is broken and is
   * destroying data. The run aborts on it.
   */
  lostBody: number;
  /**
   * CONTRACT-ONLY TRIPWIRE — posts whose body is still only in `content.text`,
   * with no rendition holding it. Contract SKIPS these (deleting the field would
   * destroy the body for good) and the run aborts, because their existence means
   * expand has not finished — most likely contract is being run too early, or the
   * old code is still writing.
   */
  notExpanded: number;
}

/**
 * What is STILL in the collection afterwards, re-read from the raw driver rather
 * than inferred from the counters. All three MUST be zero after a real run.
 */
export interface MigrationLeftovers {
  /** Documents still carrying the retired `content.text`. */
  text: number;
  /** Documents still carrying the retired `content.primaryTag`. */
  primaryTag: number;
  /** Documents still carrying the retired `translations`. */
  translations: number;
}

/** The `$set` / `$unset` operators for one document. */
export interface DocumentUpdate {
  set: Record<string, unknown>;
  unset: Record<string, ''>;
}

/** One sampled document in the dry-run report. */
export interface DocumentSample {
  id: string;
  primaryTag: string | undefined;
  variants: Array<{ tag: string | undefined; source: string }>;
  removedTranslations: number;
}

export interface MigrationSummary {
  phase: MigrationPhase;
  dryRun: boolean;
  scanned: number;
  /** Documents whose stored content differs from the migrated form. */
  changed: number;
  /** Documents actually rewritten. Always 0 on a dry run. */
  written: number;
  counts: MigrationCounts;
  /** A bounded sample. Only collected on a dry run. */
  samples: DocumentSample[];
  /** What is still in the collection afterwards, re-read from the raw driver. */
  leftovers: MigrationLeftovers;
}

function emptyCounts(): MigrationCounts {
  return {
    authorVariant: 0,
    tagged: 0,
    untagged: 0,
    machineVariants: 0,
    textRemoved: 0,
    translationsRemoved: 0,
    lostBody: 0,
    notExpanded: 0,
  };
}

/**
 * The variants already stored on a post, narrowed defensively (Mixed subdocs).
 * An ABSENT `tag` is valid — it is how a post with no resolvable language stores
 * its one rendition — so only a present-but-unusable tag disqualifies an entry.
 */
function readStoredVariants(value: unknown): PostContentVariant[] {
  if (!Array.isArray(value)) return [];
  const variants: PostContentVariant[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const variant = entry as Partial<PostContentVariant>;
    if (variant.tag !== undefined && (typeof variant.tag !== 'string' || variant.tag.length === 0)) continue;
    if (variant.source !== 'author' && variant.source !== 'machine') continue;
    if (typeof variant.text !== 'string') continue;
    variants.push(variant as PostContentVariant);
  }
  return variants;
}

/** An ISO timestamp for a legacy `translatedAt`, falling back to now. */
function toIso(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

/**
 * CONTRACT: remove the retired fields from one post. Writes nothing else — expand
 * already wrote the renditions, and re-deriving them here could only disagree
 * with whatever the live code has written since.
 *
 * THE GUARD THAT MATTERS: never unset a body that is not ALREADY, IN THE
 * DATABASE, held by a rendition. `hasStoredRendition` is read off the stored
 * document — not off a variant this migration derived — because a derived one
 * proves nothing about what was saved. Deleting `content.text` from a post expand
 * missed destroys the body irrecoverably: there is no other copy, and no later
 * expand run can rebuild it from a field that no longer exists. Such a post is
 * COUNTED and SKIPPED, and the run aborts on the count rather than shredding the
 * rest of the collection.
 *
 * A post with an empty body (a boost) has nothing to lose and is contracted
 * normally.
 */
function contractUpdate(
  post: PostVariantRow,
  text: string,
  hasStoredRendition: boolean,
  translationCount: number,
): { update: DocumentUpdate; counts: MigrationCounts; sample: DocumentSample } {
  const update: DocumentUpdate = { set: {}, unset: {} };
  const counts = emptyCounts();

  if (text.trim().length > 0 && !hasStoredRendition) {
    counts.notExpanded += 1;
  } else {
    if (post.content?.text !== undefined) {
      update.unset['content.text'] = '';
      counts.textRemoved += 1;
    }
    // A copy of `variants[0].tag`. It never shipped to production, but a
    // half-deployed environment may carry it — remove it wherever it is.
    if (post.content?.primaryTag !== undefined) {
      update.unset['content.primaryTag'] = '';
    }
    if (post.translations !== undefined) {
      update.unset.translations = '';
      counts.translationsRemoved += 1;
    }
  }

  return {
    update,
    counts,
    sample: {
      id: post._id.toString(),
      primaryTag: undefined,
      variants: [],
      removedTranslations: translationCount,
    },
  };
}

/**
 * Build one post's update for the given PHASE. Pure — the dry run and the real
 * run compute the identical result from it, which is the whole guarantee the
 * preview makes.
 *
 * EXPAND writes the renditions and touches nothing else. CONTRACT removes the
 * retired fields and writes nothing else. They are never combined: a single pass
 * that did both could not be deployed without a window in which posts render
 * blank (see the header).
 */
export function buildPostUpdate(post: PostVariantRow, phase: MigrationPhase): {
  update: DocumentUpdate;
  counts: MigrationCounts;
  sample: DocumentSample;
} {
  const update: DocumentUpdate = { set: {}, unset: {} };
  const counts = emptyCounts();

  const text = typeof post.content?.text === 'string' ? post.content.text : '';
  const storedVariants = readStoredVariants(post.content?.variants);
  const storedTranslations = Array.isArray(post.translations) ? (post.translations as LegacyTranslation[]) : [];

  // The primary language, when the post has one at all. An unusable value yields
  // NO tag rather than a bogus one — an untagged rendition is a legitimate state.
  const primaryTag = canonicalizeLanguageTag(post.language) ?? undefined;

  const authors = storedVariants.filter((variant) => variant.source === 'author');
  const machines = storedVariants.filter((variant) => variant.source === 'machine');

  if (phase === 'contract') {
    // CONTRACT removes the retired fields and writes NOTHING else. It must judge
    // safety on what is ACTUALLY STORED — never on a rendition it derived here.
    // Deriving one and then trusting it is how you delete a body that was never
    // saved: the update would unset `content.text` on the strength of a variant
    // that exists only in this function's local variable.
    return contractUpdate(post, text, authors.length > 0, storedTranslations.length);
  }

  // The primary author variant: the post's body, which until now lived in
  // `content.text`. A post with an EMPTY body (a boost) gets no variant — there
  // is no rendition, in any language. A post whose language never resolved gets
  // an UNTAGGED variant: the body is still the post and must be kept; we simply
  // do not know what language it is in, and we refuse to invent one.
  if (authors.length === 0 && text.trim().length > 0) {
    // The author wrote this body when the post was published — not now.
    const primary: PostContentVariant = { source: 'author', text, createdAt: toIso(post.createdAt) };
    if (primaryTag) primary.tag = primaryTag;
    authors.push(primary);
    counts.authorVariant += 1;
    if (primaryTag) counts.tagged += 1;
    else counts.untagged += 1;
  }

  // Every cached AI translation becomes a machine variant. A translation into a
  // language the author already wrote in is dropped (one body per tag, and the
  // author's own words always win).
  const takenTags = new Set(
    [...authors, ...machines]
      .map((variant) => variant.tag)
      .filter((tag): tag is string => tag !== undefined),
  );
  for (const translation of storedTranslations) {
    const tag = canonicalizeLanguageTag(translation.language);
    if (tag === null || takenTags.has(tag)) continue;
    if (typeof translation.text !== 'string' || translation.text.length === 0) continue;
    takenTags.add(tag);
    machines.push({
      tag,
      source: 'machine',
      text: translation.text,
      createdAt: toIso(translation.translatedAt),
    });
    counts.machineVariants += 1;
  }

  // `variants[0]` IS the primary — the author variants lead, in the order the
  // author wrote them, and the machine cache follows.
  const variants = [...authors.slice(0, MAX_AUTHOR_VARIANTS), ...machines];

  // The body must always end up in a rendition. Cannot fail by construction — an
  // unresolvable language yields an UNTAGGED variant, not no variant — so this is
  // a tripwire, and the caller aborts on it rather than letting contract later
  // delete a body that expand never saved.
  if (text.trim().length > 0 && !variants.some((variant) => variant.source === 'author')) {
    counts.lostBody += 1;
  }

  // EXPAND writes the renditions and NOTHING else. `content.text` and
  // `translations` are left exactly as they are, so the currently-deployed code —
  // which still reads them — keeps working while this runs. It simply gains a
  // field it does not look at.
  //
  // A post that already carries its renditions produces no write at all, which is
  // what makes the second expand pass (the one that catches posts created during
  // the deploy window) cheap rather than a second full rewrite of 300k documents.
  if (counts.authorVariant > 0 || counts.machineVariants > 0) {
    update.set['content.variants'] = variants;
  }

  return {
    update,
    counts,
    sample: {
      id: post._id.toString(),
      primaryTag,
      variants: variants.map((variant) => ({ tag: variant.tag, source: variant.source })),
      removedTranslations: storedTranslations.length,
    },
  };
}

function hasChanges(update: DocumentUpdate): boolean {
  return Object.keys(update.set).length > 0 || Object.keys(update.unset).length > 0;
}

function toUpdateDocument(update: DocumentUpdate): Record<string, unknown> {
  const doc: Record<string, unknown> = {};
  if (Object.keys(update.set).length > 0) doc.$set = update.set;
  if (Object.keys(update.unset).length > 0) doc.$unset = update.unset;
  return doc;
}

/** The retired full-text index over the body's old home. */
const OLD_TEXT_INDEX = 'content.text_text';

/** The full-text index over the body's new home. Multikey: it covers EVERY rendition. */
const NEW_TEXT_INDEX = 'content.variants.text_text';

/**
 * The compound index behind the saved-posts search. Its NAME is unchanged across
 * the migration — only its KEY moved (`content.text` → `content.variants.text`),
 * which is precisely what makes it dangerous. See {@link swapBodyIndexes}.
 */
const SAVED_POSTS_INDEX = 'saved_posts_text_idx';

/** Whether an existing index's key still points at the body's retired home. */
function keysTheRetiredBody(key: Record<string, unknown> | undefined): boolean {
  return key !== undefined && Object.keys(key).some((path) => path.startsWith('content.text'));
}

/**
 * Move BOTH body indexes off `content.text`. Production runs with `autoIndex`
 * off, so nothing else will do it — and each failure is silent in its own way.
 *
 * 1. **The full-text index** (`content.text_text` → `content.variants.text_text`).
 *    Left alone, post search indexes a field no document has and returns nothing,
 *    forever, with no error. A collection may hold only ONE text index, so the old
 *    one MUST be dropped before the new one is created — they cannot coexist even
 *    briefly.
 *
 *    `language_override` keeps pointing at `textSearchLanguage`, a sentinel field
 *    no document has. MongoDB treats a field literally named `language` inside an
 *    indexed document as the stemmer override and REJECTS unsupported codes with
 *    error 17262. The variant subdoc's language field is called `tag` precisely so
 *    it cannot be mistaken for one, and the override stays pinned to a
 *    non-existent field so stemming always falls back to English.
 *
 * 2. **The saved-posts compound index** (`saved_posts_text_idx`). This one is the
 *    nastier of the two: its NAME did not change, only its key did. MongoDB will
 *    not quietly redefine an existing index — `createIndex` with the same name and
 *    a different key spec FAILS with `IndexKeySpecsConflict`. So a deploy that
 *    merely re-declares it in the schema does not fix production; the old index
 *    keeps sitting there indexing a dead field. It has to be dropped BY NAME and
 *    recreated, which is what this does.
 *
 * Both steps are keyed on what is ACTUALLY in the collection (the live index
 * `key`, not just its name), so a re-run is a no-op.
 */
export async function swapBodyIndexes(dryRun: boolean): Promise<void> {
  const collection = Post.collection;
  const indexes = await collection.indexes();
  const byName = new Map(
    indexes.map((index) => [index.name, index.key as Record<string, unknown> | undefined]),
  );

  // ---- 1. The full-text index. --------------------------------------------
  const hasNewText = byName.has(NEW_TEXT_INDEX);
  const hasOldText = byName.has(OLD_TEXT_INDEX);

  if (hasNewText && !hasOldText) {
    logger.info(`[migratePostContentVariants] text index already on '${NEW_TEXT_INDEX}' — nothing to swap`);
  } else if (dryRun) {
    logger.info(
      `[migratePostContentVariants] DRY RUN — would drop '${OLD_TEXT_INDEX}'`
      + ` and create '${NEW_TEXT_INDEX}' over content.variants.text`,
    );
  } else {
    if (hasOldText) {
      await collection.dropIndex(OLD_TEXT_INDEX);
      logger.info(`[migratePostContentVariants] dropped '${OLD_TEXT_INDEX}'`);
    }
    await collection.createIndex(
      { 'content.variants.text': 'text' },
      {
        default_language: 'english',
        language_override: 'textSearchLanguage',
        name: NEW_TEXT_INDEX,
        weights: { 'content.variants.text': 1 },
      },
    );
    logger.info(`[migratePostContentVariants] created '${NEW_TEXT_INDEX}'`);
  }

  // ---- 2. The saved-posts compound index (same name, different key). -------
  const savedKey = byName.get(SAVED_POSTS_INDEX);
  const savedIsStale = keysTheRetiredBody(savedKey);

  if (byName.has(SAVED_POSTS_INDEX) && !savedIsStale) {
    logger.info(
      `[migratePostContentVariants] '${SAVED_POSTS_INDEX}' already keys the renditions — nothing to swap`,
    );
    return;
  }

  if (dryRun) {
    logger.info(
      `[migratePostContentVariants] DRY RUN — would ${savedIsStale ? 'drop and ' : ''}`
      + `create '${SAVED_POSTS_INDEX}' over { _id, content.variants.text }`,
    );
    return;
  }

  // Drop BY NAME first. The schema re-declares this index under the SAME name with
  // a new key, and MongoDB rejects that outright (`IndexKeySpecsConflict`) rather
  // than redefining it — so without the drop, the create below fails and the stale
  // index survives.
  if (savedIsStale) {
    await collection.dropIndex(SAVED_POSTS_INDEX);
    logger.info(`[migratePostContentVariants] dropped stale '${SAVED_POSTS_INDEX}' (keyed content.text)`);
  }

  await collection.createIndex(
    { _id: 1, 'content.variants.text': 1 },
    { name: SAVED_POSTS_INDEX },
  );
  logger.info(`[migratePostContentVariants] created '${SAVED_POSTS_INDEX}' over the renditions`);
}

/**
 * Migrate (or, dry, plan) every post. Split from the entry point below so it can
 * be driven without owning the MongoDB connection.
 *
 * Pages by ascending `_id` over the WHOLE collection — a filter on a field this
 * script mutates would make the scanned set shift under the cursor mid-run.
 */
export async function migratePostVariants(
  phase: MigrationPhase,
  dryRun: boolean,
): Promise<MigrationSummary> {
  const startedAt = Date.now();

  // CONTRACT is the destructive half, and it is only safe once EXPAND has landed
  // every body in a rendition. Check BEFORE deleting anything: a post whose body
  // still lives only in `content.text` would be silently emptied, with no copy
  // anywhere and no way for a later run to rebuild it.
  if (phase === 'contract') {
    const unexpanded = await countUnexpanded();
    if (unexpanded > 0) {
      throw new Error(
        `[migratePostContentVariants] ABORT: ${unexpanded} post(s) still have a body only in 'content.text'. `
        + 'CONTRACT would DESTROY them. Run PHASE=expand to completion first — and if this is non-zero after '
        + 'expand, the old code is still writing posts and the new build is not fully deployed.',
      );
    }
  }

  const total = await Post.estimatedDocumentCount();
  logger.info(`[migratePostContentVariants] PHASE=${phase} — ~${total} posts to scan`);

  const counts = emptyCounts();
  const samples: DocumentSample[] = [];
  let scanned = 0;
  let changed = 0;
  let written = 0;
  let lastId: mongoose.Types.ObjectId | null = null;
  let pendingOps: AnyBulkWriteOperation[] = [];

  // A dry run builds every operation exactly as a real one does — it just never
  // hands them to Mongo. What it reports is what a real run would write, computed
  // by the same code.
  //
  // The write goes through the RAW driver (`Post.collection`), NOT `Post.bulkWrite`.
  // This is the whole reason the migration works: `content.text`, `content.primaryTag`
  // and `translations` are no longer in the schema, and Mongoose casts update
  // documents in strict mode — it SILENTLY STRIPS unknown paths. Through the
  // model, every `$unset` here would be discarded before it reached Mongo, the
  // dead fields would survive forever, and the script would still report having
  // removed them (the counters increment before the cast). A migration that lies
  // about what it did is worse than one that fails.
  const flush = async (): Promise<void> => {
    if (pendingOps.length === 0) return;
    if (dryRun) {
      pendingOps = [];
      return;
    }
    const result = await Post.collection.bulkWrite(pendingOps, { ordered: false });
    written += result.modifiedCount;
    pendingOps = [];
  };

  for (;;) {
    const pageFilter: Record<string, unknown> = {};
    if (lastId) pageFilter._id = { $gt: lastId };

    // Read through the RAW driver for the same reason the write does: every field
    // this migration exists to move (`content.text`, `translations`) is GONE from
    // the schema. A Mongoose read is not the place to discover whether it prunes
    // them — if it did, the script would see every post as already migrated and
    // do nothing, while cheerfully reporting zero changes.
    const page = (await Post.collection
      .find(pageFilter, {
        projection: {
          _id: 1,
          language: 1,
          createdAt: 1,
          'content.text': 1,
          'content.primaryTag': 1,
          'content.variants': 1,
          translations: 1,
        },
      })
      .sort({ _id: 1 })
      .limit(PAGE_SIZE)
      .toArray()) as unknown as PostVariantRow[];

    if (page.length === 0) break;

    for (const post of page) {
      const { update, counts: postCounts, sample } = buildPostUpdate(post, phase);

      // The two tripwires are counted BEFORE the no-change skip. A post that
      // contract refuses to touch produces no update at all, so counting these
      // alongside the others would silently discard the very signal that says the
      // migration is unsafe to continue.
      counts.lostBody += postCounts.lostBody;
      counts.notExpanded += postCounts.notExpanded;

      if (!hasChanges(update)) continue;
      changed += 1;
      counts.authorVariant += postCounts.authorVariant;
      counts.tagged += postCounts.tagged;
      counts.untagged += postCounts.untagged;
      counts.machineVariants += postCounts.machineVariants;
      counts.textRemoved += postCounts.textRemoved;
      counts.translationsRemoved += postCounts.translationsRemoved;
      if (dryRun && samples.length < DRY_RUN_SAMPLE_SIZE) samples.push(sample);
      pendingOps.push({
        updateOne: { filter: { _id: post._id }, update: toUpdateDocument(update) },
      });
      if (pendingOps.length >= BULK_CHUNK_SIZE) await flush();
    }

    scanned += page.length;
    lastId = page[page.length - 1]._id;
    logger.info(
      `[migratePostContentVariants] scanned ${scanned}/~${total}, ${dryRun ? 'would migrate' : 'migrating'} ${changed}`,
    );
  }

  await flush();

  if (dryRun && samples.length > 0) {
    logger.info(`[migratePostContentVariants] DRY RUN sample — ${samples.length} post(s):`);
    for (const sample of samples) {
      const variants =
        sample.variants.map((v) => `${v.tag ?? '(untagged)'}:${v.source}`).join(', ') || '(none)';
      logger.info(
        `[migratePostContentVariants]   post ${sample.id} primaryTag=${sample.primaryTag ?? '(none)'} `
        + `variants=[${variants}] translationsRemoved=${sample.removedTranslations}`,
      );
    }
  }

  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  logger.info(
    `[migratePostContentVariants] PHASE=${phase} done in ${elapsedSeconds}s`
    + `${dryRun ? ' — DRY RUN, nothing was written' : ''}: `
    + `scanned ${scanned}, ${dryRun ? `${changed} would be migrated` : `${written} migrated (${changed} changed)`} `
    + (phase === 'expand'
      ? `(author variants ${counts.authorVariant} — ${counts.tagged} tagged, ${counts.untagged} untagged; `
        + `machine variants ${counts.machineVariants})`
      : `(content.text removed ${counts.textRemoved}; translations removed ${counts.translationsRemoved})`),
  );

  // The TRIPWIRE. A body that had nowhere to land was about to be deleted from
  // `content.text` with no rendition holding it — that is data destruction, and
  // it is not recoverable on the next run because the source field is gone. Abort
  // loudly instead of shredding the rest of the collection.
  if (counts.lostBody > 0) {
    throw new Error(
      `[migratePostContentVariants] ABORT: ${counts.lostBody} post(s) had a body that produced no rendition. `
      + 'This is impossible by construction and means the builder is broken — no further writes.',
    );
  }

  // Contract SKIPS any post whose body never made it into a rendition rather than
  // deleting it. Their existence means expand is not finished, so the run fails
  // instead of leaving the collection half-contracted.
  if (counts.notExpanded > 0) {
    throw new Error(
      `[migratePostContentVariants] ABORT: ${counts.notExpanded} post(s) still hold their body only in `
      + `'content.text'. They were SKIPPED (not destroyed). Re-run PHASE=expand — and check that the old `
      + 'code is no longer writing posts.',
    );
  }

  const leftovers = await countLeftovers();
  logger.info(
    `[migratePostContentVariants] verified by re-read: content.text on ${leftovers.text} doc(s), `
    + `content.primaryTag on ${leftovers.primaryTag}, translations on ${leftovers.translations}`,
  );

  // What the counters CLAIM means nothing; what the collection still holds is the
  // truth. The counters increment while the update is being BUILT, so they would
  // report a clean sweep even if every write were discarded on the way out —
  // exactly what a Mongoose strict-mode cast does to a path the schema no longer
  // declares. A migration must not be its own witness.
  if (!dryRun) {
    if (phase === 'expand') {
      // EXPAND leaves the retired fields alone by design, so `leftovers` is
      // expected to be non-zero here. What must be zero is the number of posts
      // whose body has NOT reached a rendition — that is what makes contract safe.
      const unexpanded = await countUnexpanded();
      if (unexpanded > 0) {
        throw new Error(
          `[migratePostContentVariants] ABORT: expand finished but ${unexpanded} post(s) still have a body `
          + 'only in `content.text`. Do NOT run contract.',
        );
      }
      logger.info('[migratePostContentVariants] expand verified: every body is in a rendition');
    } else {
      const stillThere = leftovers.text + leftovers.primaryTag + leftovers.translations;
      if (stillThere > 0) {
        throw new Error(
          `[migratePostContentVariants] ABORT: the retired fields are STILL PRESENT after contract `
          + `(content.text: ${leftovers.text}, content.primaryTag: ${leftovers.primaryTag}, `
          + `translations: ${leftovers.translations}). The writes did not land — do NOT trust the counters above.`,
        );
      }
    }
  }

  return { phase, dryRun, scanned, changed, written, counts, samples, leftovers };
}

/**
 * Posts whose body still exists ONLY in the retired `content.text` — visible
 * characters there, no rendition holding them.
 *
 * This is the single number that decides whether contract is safe to run. It must
 * be zero before contract deletes anything, and zero again after expand finishes.
 * A non-zero value after a full expand means the OLD code is still writing posts
 * (the deploy has not fully rolled out), and contracting now would empty exactly
 * those posts.
 *
 * Read through the raw driver: the schema no longer declares `content.text`, so a
 * Mongoose query would strip it from the filter and match everything.
 */
async function countUnexpanded(): Promise<number> {
  return Post.collection.countDocuments({
    'content.text': { $regex: /\S/ },
    'content.variants.0': { $exists: false },
  });
}

/**
 * COUNT WHAT IS ACTUALLY STILL THERE, by re-reading the collection.
 *
 * The per-document counters above say what the script BELIEVED it did. They are
 * incremented while building the update, before it is handed to Mongo — so they
 * would report a clean sweep even if every `$unset` had been silently discarded
 * on the way out (which is precisely what `Post.bulkWrite` would have done to
 * them, since the schema no longer declares these paths). A migration must not be
 * its own witness.
 *
 * These counts come from the RAW driver, so they see the fields whether or not
 * the schema still knows about them. After a real run they MUST all be zero; a
 * non-zero count is a failed migration, and the caller says so loudly.
 */
async function countLeftovers(): Promise<MigrationLeftovers> {
  const [text, primaryTag, translations] = await Promise.all([
    Post.collection.countDocuments({ 'content.text': { $exists: true } }),
    Post.collection.countDocuments({ 'content.primaryTag': { $exists: true } }),
    Post.collection.countDocuments({ translations: { $exists: true } }),
  ]);
  return { text, primaryTag, translations };
}

/**
 * Read the phase off the environment. There is NO default: the two phases are a
 * non-destructive one and a destructive one, and a script that guesses which you
 * meant is a script that eventually guesses wrong.
 */
function readPhase(): MigrationPhase {
  const phase = process.env.PHASE;
  if (phase === 'expand' || phase === 'contract') return phase;
  throw new Error(
    `[migratePostContentVariants] PHASE must be 'expand' or 'contract' (got ${phase ?? 'nothing'}). `
    + 'expand = write the renditions, safe while the old code is live. '
    + 'contract = delete content.text/translations, safe ONLY once the new code is fully deployed. '
    + 'The sequence is: expand → deploy → expand again → contract.',
  );
}

async function migratePostContentVariants(): Promise<void> {
  const phase = readPhase();
  const dryRun = process.env.DRY_RUN === 'true';
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/mention';
  const dbName = `mention-${process.env.NODE_ENV || 'development'}`;

  try {
    await mongoose.connect(mongoUri, { dbName });
    logger.info(
      `[migratePostContentVariants] connected to MongoDB (${dbName}), PHASE=${phase}`
      + `${dryRun ? ' — DRY RUN, no writes will be performed' : ''}`,
    );

    await migratePostVariants(phase, dryRun);

    // The indexes move in CONTRACT, not expand. During expand the old code is
    // still live and still reads `content.text`, so its indexes must stay; and a
    // collection may hold only one text index, so the swap is a single instant
    // that belongs on the far side of the deploy.
    if (phase === 'contract') {
      await swapBodyIndexes(dryRun);
    }

    await mongoose.disconnect();
  } catch (error) {
    logger.error('[migratePostContentVariants] failed', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

if (require.main === module) {
  // Exit deterministically: imported singletons (BullMQ/Redis connections, the
  // MediaCache workers) keep the event loop alive, so the process would sit
  // RUNNING forever after the work completes. Mirrors normalizeFederatedText.
  migratePostContentVariants()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('[migratePostContentVariants] unhandled failure', error);
      process.exit(1);
    });
}

export default migratePostContentVariants;
