/**
 * One-shot backfill: normalize the whitespace of every piece of REMOTE text
 * already stored in Mongo.
 *
 * Third-party text used to be persisted exactly as the remote server sent it —
 * indentation, embedded newlines and all. That is invisible in HTML (whitespace
 * collapses at render time) but NOT in our clients: React Native Web renders
 * `Text` with `white-space: pre-wrap`, so a pretty-printed remote body
 * (`<p>\n      Hola\n    </p>`) showed up as a blank line plus a six-space
 * indent. The ingest paths now run every remote value through the canonical
 * `normalizeInlineText` / `normalizeMultilineText` from `@oxyhq/core`, but rows
 * written before that fix stay dirty forever — nothing rewrites a stored post,
 * and an actor is only rewritten if the remote profile happens to change. This
 * script cleans them.
 *
 * What it normalizes (the same helper the ingest path now uses for each field):
 *   - `Post.content.variants[].text` — MULTILINE (the author's paragraphs survive).
 *                                    EVERY rendition, not just the primary: each
 *                                    one is remote text and each one is rendered.
 *   - `Post.federation.spoilerText`— INLINE (a CW label is one line; unset when
 *                                    it normalizes to empty)
 *   - `Post.content.media[].alt`   — INLINE (unset when it normalizes to empty)
 *   - `FederatedActor.username`    — INLINE
 *   - `FederatedActor.summary`     — MULTILINE (a bio is a body)
 *   - `FederatedActor.fields[].name` / `.value` — INLINE
 *
 * Only FEDERATED posts (`federation != null`) are touched: native post bodies
 * are the local author's own text and are not ours to rewrite.
 *
 * Idempotent (a second run writes nothing), batched through a stable ascending
 * `_id` cursor with `bulkWrite` (never loads the collection into memory), and it
 * only writes the documents whose values ACTUALLY change.
 *
 * DRY RUN
 * -------
 * This rewrites the body of hundreds of thousands of production posts, so run it
 * dry FIRST. `DRY_RUN=true` scans the same documents and computes the same
 * updates, but performs NO `bulkWrite`. It reports how many documents WOULD
 * change (not how many were seen), the per-field breakdown, and a bounded sample
 * of the real before/after values. The sample is JSON-quoted deliberately: this
 * backfill is ENTIRELY about whitespace, and a diff that prints `\n` and leading
 * spaces as themselves shows nothing at all.
 *
 * Same `DRY_RUN=true` convention as the sibling backfills in this directory and
 * as oxy-api's `normalize-user-text-fields.ts`.
 *
 * Run — as a Fargate one-shot against the deployed backend image (command
 * overridden), or locally with the same env:
 *   DRY_RUN=true bun packages/backend/dist/src/scripts/normalizeFederatedText.js   # preview, writes nothing
 *   bun packages/backend/dist/src/scripts/normalizeFederatedText.js                # apply
 *
 * Env:
 *   MONGODB_URI   the cluster (injected by ECS from SSM)
 *   NODE_ENV      selects the database (`mention-<NODE_ENV>`)
 *   DRY_RUN=true  plan only, no writes
 */

import mongoose from 'mongoose';
import { normalizeInlineText, normalizeMultilineText } from '@oxyhq/core';
import { Post } from '../models/Post';
import FederatedActor from '../models/FederatedActor';
import { logger } from '../utils/logger';

/** Documents scanned per page (stable `_id` cursor pagination). */
const PAGE_SIZE = 500;

/** Updates flushed per `bulkWrite` chunk. */
const BULK_CHUNK_SIZE = 500;

/** How many changed documents a dry run reports in full, per collection. */
const DRY_RUN_SAMPLE_SIZE = 20;

/** Matches the posts that carry remote text: everything with AP/atproto metadata. */
const FEDERATED_POST_FILTER: Record<string, unknown> = { federation: { $ne: null } };

/** The fields this script reads off a post (nothing else is loaded). */
export interface FederatedPostRow {
  _id: mongoose.Types.ObjectId;
  content?: {
    variants?: unknown;
    media?: unknown;
  };
  federation?: {
    spoilerText?: unknown;
  };
}

/** The fields this script reads off a federated actor. */
export interface FederatedActorRow {
  _id: mongoose.Types.ObjectId;
  uri?: string;
  username?: unknown;
  summary?: unknown;
  fields?: unknown;
}

/** Per-field tally of how many post values this run rewrote (or would rewrite). */
export interface PostCounts {
  text: number;
  spoilerText: number;
  mediaAlt: number;
}

/** Per-field tally of how many actor values this run rewrote (or would rewrite). */
export interface ActorCounts {
  username: number;
  summary: number;
  fields: number;
}

/**
 * The `$set` / `$unset` operators for one document, built incrementally.
 *
 * An `$unset` (rather than a `$set` to `''`) is what an emptied optional label
 * needs: `federation.spoilerText` and `media[].alt` are read as "present ⇒ show
 * it", so a value that normalizes to nothing must DISAPPEAR, not become blank.
 */
export interface DocumentUpdate {
  set: Record<string, unknown>;
  unset: Record<string, ''>;
}

/** One field a run would rewrite, rendered for the dry-run report. */
export interface FieldChange {
  /** The dotted path being written, e.g. `content.media.0.alt`. */
  path: string;
  /** The stored value, JSON-quoted so its whitespace is visible. */
  before: string;
  /** The normalized value, JSON-quoted — or `(unset)` when the field is removed. */
  after: string;
}

/** One sampled document in the dry-run report. */
export interface DocumentSample {
  id: string;
  changes: FieldChange[];
}

/** What one collection's pass did (or, dry, would do). */
export interface CollectionResult<TCounts> {
  scanned: number;
  /** Documents whose stored text differs from its normalized form. */
  changed: number;
  /** Documents actually rewritten. Always 0 on a dry run. */
  written: number;
  /** Which FIELDS were dirty, across the changed documents. */
  counts: TCounts;
  /** A bounded before/after sample. Only collected on a dry run. */
  samples: DocumentSample[];
}

export interface NormalizationSummary {
  dryRun: boolean;
  posts: CollectionResult<PostCounts>;
  actors: CollectionResult<ActorCounts>;
}

/** Shown in place of the new value for a field the run would REMOVE. */
const UNSET_MARKER = '(unset)';

function emptyUpdate(): DocumentUpdate {
  return { set: {}, unset: {} };
}

function hasChanges(update: DocumentUpdate): boolean {
  return Object.keys(update.set).length > 0 || Object.keys(update.unset).length > 0;
}

/** Build the Mongo update document for the operators actually collected. */
function toUpdateDocument(update: DocumentUpdate): Record<string, unknown> {
  const doc: Record<string, unknown> = {};
  if (Object.keys(update.set).length > 0) doc.$set = update.set;
  if (Object.keys(update.unset).length > 0) doc.$unset = update.unset;
  return doc;
}

/**
 * Stage an OPTIONAL inline label: rewritten when it changes, unset when it
 * normalizes to nothing. A non-string stored value is left untouched — this
 * script normalizes whitespace, it does not repair a corrupt schema.
 */
function stageOptionalInline(update: DocumentUpdate, path: string, value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = normalizeInlineText(value);
  if (normalized === value) return false;
  if (normalized.length === 0) {
    update.unset[path] = '';
  } else {
    update.set[path] = normalized;
  }
  return true;
}

/** Collect every normalization needed by a single federated post. */
export function buildPostUpdate(post: FederatedPostRow): { update: DocumentUpdate; counts: PostCounts } {
  const update = emptyUpdate();
  const counts: PostCounts = { text: 0, spoilerText: 0, mediaAlt: 0 };

  // Each rendition is addressed by INDEX, so the untouched fields of a variant
  // (its tag, source, alt map, media override) are never re-serialized and cannot
  // be lost. The body always stays a string — an empty rendition is not written
  // back as one, it simply never existed.
  const variants = post.content?.variants;
  if (Array.isArray(variants)) {
    variants.forEach((variant, index) => {
      if (typeof variant !== 'object' || variant === null) return;
      const text = (variant as { text?: unknown }).text;
      if (typeof text !== 'string') return;
      const normalized = normalizeMultilineText(text);
      if (normalized === text) return;
      update.set[`content.variants.${index}.text`] = normalized;
      counts.text += 1;
    });
  }

  if (stageOptionalInline(update, 'federation.spoilerText', post.federation?.spoilerText)) {
    counts.spoilerText += 1;
  }

  // `content.media` is a Mixed array, so each item is addressed by index rather
  // than rewriting the whole array — the untouched fields of an item (id, type,
  // dimensions, cache flags) are never re-serialized and cannot be lost.
  const media = post.content?.media;
  if (Array.isArray(media)) {
    media.forEach((item, index) => {
      if (typeof item !== 'object' || item === null) return;
      const alt = (item as { alt?: unknown }).alt;
      if (stageOptionalInline(update, `content.media.${index}.alt`, alt)) {
        counts.mediaAlt += 1;
      }
    });
  }

  return { update, counts };
}

/** Collect every normalization needed by a single federated actor. */
export function buildActorUpdate(actor: FederatedActorRow): { update: DocumentUpdate; counts: ActorCounts } {
  const update = emptyUpdate();
  const counts: ActorCounts = { username: 0, summary: 0, fields: 0 };

  // `username` is REQUIRED and half of the unique `{domain, username}` index, so
  // it is only ever rewritten to a non-empty value: a username that normalizes
  // away entirely is left alone rather than made unsavable.
  const username = actor.username;
  if (typeof username === 'string') {
    const normalized = normalizeInlineText(username);
    if (normalized !== username && normalized.length > 0) {
      update.set.username = normalized;
      counts.username += 1;
    }
  }

  const summary = actor.summary;
  if (typeof summary === 'string') {
    const normalized = normalizeMultilineText(summary);
    if (normalized !== summary) {
      update.set.summary = normalized;
      counts.summary += 1;
    }
  }

  // Profile fields are addressed by index for the same reason as media items:
  // `verifiedAt` on an untouched entry must survive. An entry whose label or
  // value normalizes to empty is left as-is — dropping stored profile fields is
  // a product decision, not a whitespace fix.
  const fields = actor.fields;
  if (Array.isArray(fields)) {
    fields.forEach((field, index) => {
      if (typeof field !== 'object' || field === null) return;
      const entry = field as { name?: unknown; value?: unknown };
      for (const key of ['name', 'value'] as const) {
        const value = entry[key];
        if (typeof value !== 'string') continue;
        const normalized = normalizeInlineText(value);
        if (normalized !== value && normalized.length > 0) {
          update.set[`fields.${index}.${key}`] = normalized;
          counts.fields += 1;
        }
      }
    });
  }

  return { update, counts };
}

/**
 * Read the value a dotted update path points at in the ORIGINAL document, so the
 * dry run can put what is on disk next to what it would become. A numeric
 * segment indexes into an array (`content.media.0.alt`, `fields.1.name`).
 */
function readPath(document: unknown, path: string): unknown {
  let current: unknown = document;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** JSON-quote a stored value so its newlines and padding are actually visible. */
function renderValue(value: unknown): string {
  const rendered = JSON.stringify(value);
  return rendered === undefined ? 'undefined' : rendered;
}

/**
 * Render one document's staged update as before/after pairs — the dry run's whole
 * point. Both sides are JSON-quoted: the difference between `"Hola"` and
 * `"\n      Hola"` is exactly what this backfill exists to remove, and it is
 * invisible in an unquoted diff.
 */
export function describeChanges(document: unknown, update: DocumentUpdate): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const [path, value] of Object.entries(update.set)) {
    changes.push({ path, before: renderValue(readPath(document, path)), after: renderValue(value) });
  }
  for (const path of Object.keys(update.unset)) {
    changes.push({ path, before: renderValue(readPath(document, path)), after: UNSET_MARKER });
  }
  return changes;
}

/** Print the sampled before/after pairs a dry run collected. */
function logSamples(kind: string, samples: DocumentSample[]): void {
  if (samples.length === 0) return;
  logger.info(
    `[normalizeFederatedText] DRY RUN sample — ${samples.length} ${kind}(s), values JSON-quoted so whitespace is visible:`,
  );
  for (const sample of samples) {
    for (const change of sample.changes) {
      logger.info(
        `[normalizeFederatedText]   ${kind} ${sample.id} ${change.path}: ${change.before} -> ${change.after}`,
      );
    }
  }
}

/**
 * Normalize the remote text on every federated post.
 *
 * Pages by ascending `_id` over a filter that only matches on `federation`,
 * which this script never mutates — so the scanned set is stable for the run.
 */
async function normalizePosts(dryRun: boolean): Promise<CollectionResult<PostCounts>> {
  const total = await Post.countDocuments(FEDERATED_POST_FILTER);
  logger.info(`[normalizeFederatedText] ${total} federated posts to scan`);

  const counts: PostCounts = { text: 0, spoilerText: 0, mediaAlt: 0 };
  const samples: DocumentSample[] = [];
  let scanned = 0;
  let changed = 0;
  let written = 0;
  let lastId: mongoose.Types.ObjectId | null = null;
  let pendingOps: mongoose.AnyBulkWriteOperation<typeof Post>[] = [];

  // A dry run builds every operation exactly as a real one does — it just never
  // hands them to Mongo. That is the whole guarantee: what it reports is what a
  // real run would write, computed by the same code.
  const flush = async (): Promise<void> => {
    if (pendingOps.length === 0) return;
    if (dryRun) {
      pendingOps = [];
      return;
    }
    const result = await Post.bulkWrite(pendingOps, { ordered: false });
    written += result.modifiedCount;
    pendingOps = [];
  };

  for (;;) {
    const pageFilter: Record<string, unknown> = { ...FEDERATED_POST_FILTER };
    if (lastId) pageFilter._id = { $gt: lastId };

    const page = await Post.find(pageFilter, {
      _id: 1,
      'content.variants': 1,
      'content.media': 1,
      'federation.spoilerText': 1,
    })
      .sort({ _id: 1 })
      .limit(PAGE_SIZE)
      .lean<FederatedPostRow[]>();

    if (page.length === 0) break;

    for (const post of page) {
      const { update, counts: postCounts } = buildPostUpdate(post);
      if (!hasChanges(update)) continue;
      changed += 1;
      counts.text += postCounts.text;
      counts.spoilerText += postCounts.spoilerText;
      counts.mediaAlt += postCounts.mediaAlt;
      if (dryRun && samples.length < DRY_RUN_SAMPLE_SIZE) {
        samples.push({ id: post._id.toString(), changes: describeChanges(post, update) });
      }
      pendingOps.push({
        updateOne: {
          filter: { _id: post._id },
          update: toUpdateDocument(update),
        },
      });
      if (pendingOps.length >= BULK_CHUNK_SIZE) await flush();
    }

    scanned += page.length;
    lastId = page[page.length - 1]._id;
    logger.info(
      `[normalizeFederatedText] posts: scanned ${scanned}/${total}, ${dryRun ? 'would rewrite' : 'rewriting'} ${changed}`,
    );
  }

  await flush();
  return { scanned, changed, written, counts, samples };
}

/** Normalize the remote text on every federated actor (both protocols). */
async function normalizeActors(dryRun: boolean): Promise<CollectionResult<ActorCounts>> {
  const total = await FederatedActor.countDocuments({});
  logger.info(`[normalizeFederatedText] ${total} federated actors to scan`);

  const counts: ActorCounts = { username: 0, summary: 0, fields: 0 };
  const samples: DocumentSample[] = [];
  let scanned = 0;
  let changed = 0;
  let written = 0;
  let lastId: mongoose.Types.ObjectId | null = null;
  let pendingOps: mongoose.AnyBulkWriteOperation<typeof FederatedActor>[] = [];

  const flush = async (): Promise<void> => {
    if (pendingOps.length === 0) return;
    if (dryRun) {
      pendingOps = [];
      return;
    }
    const result = await FederatedActor.bulkWrite(pendingOps, { ordered: false });
    written += result.modifiedCount;
    pendingOps = [];
  };

  for (;;) {
    const pageFilter: Record<string, unknown> = {};
    if (lastId) pageFilter._id = { $gt: lastId };

    const page = await FederatedActor.find(pageFilter, {
      _id: 1,
      uri: 1,
      username: 1,
      summary: 1,
      fields: 1,
    })
      .sort({ _id: 1 })
      .limit(PAGE_SIZE)
      .lean<FederatedActorRow[]>();

    if (page.length === 0) break;

    for (const actor of page) {
      const { update, counts: actorCounts } = buildActorUpdate(actor);
      if (!hasChanges(update)) continue;
      changed += 1;
      counts.username += actorCounts.username;
      counts.summary += actorCounts.summary;
      counts.fields += actorCounts.fields;
      if (dryRun && samples.length < DRY_RUN_SAMPLE_SIZE) {
        samples.push({ id: actor._id.toString(), changes: describeChanges(actor, update) });
      }
      pendingOps.push({
        updateOne: {
          filter: { _id: actor._id },
          update: toUpdateDocument(update),
        },
      });
      if (pendingOps.length >= BULK_CHUNK_SIZE) await flush();
    }

    scanned += page.length;
    lastId = page[page.length - 1]._id;
    logger.info(
      `[normalizeFederatedText] actors: scanned ${scanned}/${total}, ${dryRun ? 'would rewrite' : 'rewriting'} ${changed}`,
    );
  }

  await flush();
  return { scanned, changed, written, counts, samples };
}

/**
 * Scan both collections, normalize (or, dry, plan) and report. Split from the
 * entry point below so it can be driven without a MongoDB connection.
 */
export async function normalizeStoredText(dryRun: boolean): Promise<NormalizationSummary> {
  const startedAt = Date.now();

  const posts = await normalizePosts(dryRun);
  logSamples('post', posts.samples);

  const actors = await normalizeActors(dryRun);
  logSamples('actor', actors.samples);

  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  const describeWrites = (result: CollectionResult<unknown>): string =>
    dryRun
      ? `${result.changed} would be rewritten`
      : `${result.written} rewritten (${result.changed} changed)`;

  logger.info(
    `[normalizeFederatedText] done in ${elapsedSeconds}s${dryRun ? ' — DRY RUN, nothing was written' : ''}: `
    + `posts scanned ${posts.scanned}, ${describeWrites(posts)} `
    + `(text ${posts.counts.text}, spoilerText ${posts.counts.spoilerText}, media alt ${posts.counts.mediaAlt}); `
    + `actors scanned ${actors.scanned}, ${describeWrites(actors)} `
    + `(username ${actors.counts.username}, summary ${actors.counts.summary}, fields ${actors.counts.fields})`,
  );

  return { dryRun, posts, actors };
}

async function normalizeFederatedText(): Promise<void> {
  const dryRun = process.env.DRY_RUN === 'true';
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/mention';
  const dbName = `mention-${process.env.NODE_ENV || 'development'}`;

  try {
    await mongoose.connect(mongoUri, { dbName });
    logger.info(
      `[normalizeFederatedText] connected to MongoDB (${dbName})${dryRun ? ' — DRY RUN, no writes will be performed' : ''}`,
    );

    await normalizeStoredText(dryRun);

    await mongoose.disconnect();
  } catch (error) {
    logger.error('[normalizeFederatedText] failed', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

if (require.main === module) {
  // Exit deterministically: imported singletons (BullMQ/Redis connections, the
  // MediaCache workers) keep the event loop alive, so the process would sit
  // RUNNING forever after the work completes. Mirrors recomputeFederatedEngagement.
  normalizeFederatedText()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('[normalizeFederatedText] unhandled failure', error);
      process.exit(1);
    });
}

export default normalizeFederatedText;
