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
 *   - `Post.content.text`          — MULTILINE (the author's paragraphs survive)
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
 * Runnable as a Fargate one-shot post-deploy:
 *   node dist/scripts/normalizeFederatedText.js
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

/** Matches the posts that carry remote text: everything with AP/atproto metadata. */
const FEDERATED_POST_FILTER: Record<string, unknown> = { federation: { $ne: null } };

/** The fields this script reads off a post (nothing else is loaded). */
export interface FederatedPostRow {
  _id: mongoose.Types.ObjectId;
  content?: {
    text?: unknown;
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

/** Per-field tally of how many post values this run actually rewrote. */
export interface PostCounts {
  text: number;
  spoilerText: number;
  mediaAlt: number;
}

/** Per-field tally of how many actor values this run actually rewrote. */
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

  const text = post.content?.text;
  if (typeof text === 'string') {
    const normalized = normalizeMultilineText(text);
    if (normalized !== text) {
      // The body always stays a string (`content.text` defaults to `''`): an
      // empty body is legitimate on a CW-only or media-only federated post.
      update.set['content.text'] = normalized;
      counts.text += 1;
    }
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
 * Normalize the remote text on every federated post.
 *
 * Pages by ascending `_id` over a filter that only matches on `federation`,
 * which this script never mutates — so the scanned set is stable for the run.
 */
async function normalizePosts(counts: PostCounts): Promise<{ scanned: number; updated: number }> {
  const total = await Post.countDocuments(FEDERATED_POST_FILTER);
  logger.info(`[normalizeFederatedText] ${total} federated posts to scan`);

  let scanned = 0;
  let updated = 0;
  let lastId: mongoose.Types.ObjectId | null = null;
  let pendingOps: mongoose.AnyBulkWriteOperation<typeof Post>[] = [];

  const flush = async (): Promise<void> => {
    if (pendingOps.length === 0) return;
    const result = await Post.bulkWrite(pendingOps, { ordered: false });
    updated += result.modifiedCount;
    pendingOps = [];
  };

  for (;;) {
    const pageFilter: Record<string, unknown> = { ...FEDERATED_POST_FILTER };
    if (lastId) pageFilter._id = { $gt: lastId };

    const page = await Post.find(pageFilter, {
      _id: 1,
      'content.text': 1,
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
      counts.text += postCounts.text;
      counts.spoilerText += postCounts.spoilerText;
      counts.mediaAlt += postCounts.mediaAlt;
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
    logger.info(`[normalizeFederatedText] posts: scanned ${scanned}/${total}, rewritten ${updated + pendingOps.length}`);
  }

  await flush();
  return { scanned, updated };
}

/** Normalize the remote text on every federated actor (both protocols). */
async function normalizeActors(counts: ActorCounts): Promise<{ scanned: number; updated: number }> {
  const total = await FederatedActor.countDocuments({});
  logger.info(`[normalizeFederatedText] ${total} federated actors to scan`);

  let scanned = 0;
  let updated = 0;
  let lastId: mongoose.Types.ObjectId | null = null;
  let pendingOps: mongoose.AnyBulkWriteOperation<typeof FederatedActor>[] = [];

  const flush = async (): Promise<void> => {
    if (pendingOps.length === 0) return;
    const result = await FederatedActor.bulkWrite(pendingOps, { ordered: false });
    updated += result.modifiedCount;
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
      counts.username += actorCounts.username;
      counts.summary += actorCounts.summary;
      counts.fields += actorCounts.fields;
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
    logger.info(`[normalizeFederatedText] actors: scanned ${scanned}/${total}, rewritten ${updated + pendingOps.length}`);
  }

  await flush();
  return { scanned, updated };
}

async function normalizeFederatedText(): Promise<void> {
  const startedAt = Date.now();
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/mention';
  const dbName = `mention-${process.env.NODE_ENV || 'development'}`;

  try {
    await mongoose.connect(mongoUri, { dbName });
    logger.info(`[normalizeFederatedText] connected to MongoDB (${dbName})`);

    const postCounts: PostCounts = { text: 0, spoilerText: 0, mediaAlt: 0 };
    const actorCounts: ActorCounts = { username: 0, summary: 0, fields: 0 };

    const posts = await normalizePosts(postCounts);
    const actors = await normalizeActors(actorCounts);

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[normalizeFederatedText] done in ${elapsedSeconds}s: `
      + `posts scanned ${posts.scanned}, rewritten ${posts.updated} `
      + `(text ${postCounts.text}, spoilerText ${postCounts.spoilerText}, media alt ${postCounts.mediaAlt}); `
      + `actors scanned ${actors.scanned}, rewritten ${actors.updated} `
      + `(username ${actorCounts.username}, summary ${actorCounts.summary}, fields ${actorCounts.fields})`,
    );

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
