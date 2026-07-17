/**
 * One-shot REPAIR of already-stored Bluesky posts by re-mapping them through the
 * CURRENT connectors.
 *
 * WHY
 *   PR #439 (commit d77a9cb2, already on main) fixed how Bluesky content is
 *   ingested, but the fixes are INGEST-ONLY: posts stored before it landed still
 *   render with the pre-fix defects — broken/truncated links, dropped images, raw
 *   `bsky.app/search` hashtag anchors, dead `@handle` mentions, and doubled actor
 *   handles (`@gothamist.com@gothamist.com`). A re-`Create` cannot fix them; each
 *   post must be re-mapped from its source and updated in place.
 *
 * WHAT IT REPAIRS — there are TWO Bluesky ingest paths and this script covers both:
 *
 *   1. brid.gy ActivityPub path (`--path bridgy`) — posts whose `federation`
 *      object URL is on `bsky.brid.gy` (Bridgy Fed bridges Bluesky into the
 *      fediverse over ActivityPub). Re-fetches the source AP object with a signed
 *      GET and rebuilds body / media / hashtags / mentions through the fresh inbox
 *      mapping — `resolveInboundMentionsExisting` (the LOOKUP-ONLY, never-create
 *      mention resolver — see below) + `applyMentionPlaceholders` +
 *      `buildFederatedNoteContentForEdit`. That folds in the #439 fixes:
 *      `rewriteHashtagAnchors` (brid.gy `#tag` anchors), `apMentions`
 *      (`bsky.app/profile` anchor → `[mention:<id>]`), and
 *      `apMedia.classifyFromApType` (recovers images the old MIME/extension check
 *      dropped). Unlike the live inbox path (`resolveInboundMentions`), the repair
 *      resolves mentions against ALREADY-STORED actors only: it never fetches or
 *      mints a `FederatedActor`, so a bulk sweep can never pollute the federated
 *      index with 0-post ghost users for every mentioned account.
 *
 *   2. direct atproto path (`--path atproto`) — posts whose `federation.activityId`
 *      is a bare `at://` URI (the read/discovery connector). Re-fetches the post's
 *      current hydrated PostView from the Bluesky AppView and re-runs
 *      `post.mapper` (`refetchAtprotoPostForRepair`), folding in the #439 fixes:
 *      `#link`/`#mention` facet resolution (UTF-8 byte-indexed), reply threading
 *      (`parentPostId`/`threadId`), and quote posts (`quoteOf`). The actor
 *      HANDLE fix (`splitHandle`: apex `gothamist.com` → `@gothamist.com@bsky.social`,
 *      not doubled) lives on the `FederatedActor` doc, so it is repaired ONCE per
 *      distinct actor (deduped), not per post.
 *
 * HOW EACH PATH RE-FETCHES + RE-MAPS + DIFFS
 *   Both paths re-derive the SAME storable fields fresh ingest would produce, then
 *   compare them against what is stored and WRITE ONLY the fields that actually
 *   changed (`Post.updateOne` with a minimal `$set`/`$unset`). A post whose fresh
 *   mapping equals its stored state is left untouched — no `updatedAt` churn, no
 *   spurious "edited" state. The repair is deliberately non-destructive: it never
 *   blanks a body, never drops media, and never deletes a content-bearing post
 *   whose source 404s (that post still renders; a transient/removed upstream is not
 *   a reason to destroy a local copy that may carry local engagement). It stays
 *   scoped to exactly the fields #439 changed on each path.
 *
 * OUTCOMES (per post): `repaired` (a field changed — written, or in dry-run WOULD
 *   be), `unchanged` (fresh mapping matched storage), `gone` (source removed
 *   upstream — LEFT in place, never deleted), `fetch-failed` (transient — left
 *   untouched so a later run can still recover it), `skipped` (no source URL /
 *   missing author).
 *
 * FLAGS (plain argv):
 *   --dry-run              log what WOULD change; write nothing to Mongo (neither
 *                          Post docs nor the FederatedActor handle repair). Mention
 *                          resolution during the re-map is LOOKUP-ONLY
 *                          (`resolveInboundMentionsExisting`): it matches each
 *                          mentioned actor against already-stored identities and
 *                          never fetches or creates a `FederatedActor`, so a repair
 *                          run mints NO new actor rows in either mode. The scanned
 *                          posts themselves are never modified in dry-run.
 *   --limit N              cap the number of posts processed (a canary budget,
 *                          shared across both paths).
 *   --path atproto|bridgy|all   which ingest path(s) to repair (default: all).
 *   --actor <uri>          restrict to one actor (AP actor URI for bridgy, or the
 *                          `did:` for atproto), matched on `federation.actorUri`.
 *   --concurrency N        how many posts to repair in parallel (default 8, clamped
 *                          to 32). The sweep is I/O-bound (signed fetch + oxy-api
 *                          media round-trips), so a small pool overlaps the network
 *                          waits for ~8-10x wall-clock. Keep it conservative to
 *                          avoid hammering oxy-api's media-cache endpoints.
 *
 * Idempotent + forward-only: batched by a stable ASCENDING `_id` cursor; a repaired
 * post re-maps to the same fields on a second run (no change ⇒ no write), so
 * re-running is safe and cheap.
 *
 * RUN AS A FARGATE ONE-SHOT (post-deploy, in-VPC):
 *   bun packages/backend/dist/src/scripts/reingestBlueskyPosts.js --dry-run
 *   bun packages/backend/dist/src/scripts/reingestBlueskyPosts.js --path bridgy --limit 50
 *   bun packages/backend/dist/src/scripts/reingestBlueskyPosts.js            # full live sweep
 *
 * RUN OVER THE SSM TUNNEL (prod Mongo forwarded to 127.0.0.1:47017):
 *   MONGODB_URI='mongodb://127.0.0.1:47017/?directConnection=true' \
 *   NODE_ENV=production \
 *   bun packages/backend/src/scripts/reingestBlueskyPosts.ts --dry-run --limit 20
 *   (drop --dry-run to write; the tunnel is fine for this cursor-paged sweep.)
 */

import mongoose from 'mongoose';
import { PostType, type MediaItem, type PostContentVariant } from '@mention/shared-types';
import { Post } from '../models/Post';
import FederatedActor from '../models/FederatedActor';
import { logger } from '../utils/logger';
import { normalizePostHashtags } from '../utils/textProcessing';
import type { ExtractedMediaAttachment } from '../connectors/shared/federatedMedia';
import { buildFederatedNoteContentForEdit } from '../connectors/activitypub/apPostContent';
import { applyMentionPlaceholders, resolveInboundMentionsExisting } from '../connectors/activitypub/apMentions';
import { signedFetch } from '../connectors/activitypub/helpers';
import { AP_CONTENT_TYPE } from '../connectors/activitypub/constants';
import { refetchAtprotoPostForRepair } from '../connectors/atproto/post.mapper';
import { fetchAndUpsertAtprotoProfile, splitHandle } from '../connectors/atproto/profile.mapper';
import { mapWithConcurrency, DEFAULT_CONCURRENCY, MAX_CONCURRENCY } from './mapWithConcurrency';

/** Posts scanned per page (stable `_id` cursor pagination). */
const PAGE_SIZE = 500;

/**
 * Hard per-post wall-clock cap on a single post's repair. Defence-in-depth: every
 * network await a repair issues (brid.gy `signedFetch`, the atproto AppView fetch,
 * a mention lookup) is individually bounded, but a race against this timer
 * guarantees ONE slow/unresponsive remote can never freeze the whole sweep. A
 * timed-out post is counted `fetch-failed` and skipped; a later run recovers it.
 */
const REPAIR_TIMEOUT_MS = 45_000;

/** HTTP statuses that mean the remote object is permanently gone. */
const GONE_STATUS_CODES = new Set([404, 410]);

/** A brid.gy-hosted federation URL (the AP object / actor lives on `bsky.brid.gy`). */
const BRIDGY_HOST_RE = /bsky\.brid\.gy/i;

/** A bare atproto AT-URI (`at://<authority>/<collection>/<rkey>`) `federation.activityId`. */
const AT_URI_PREFIX_RE = /^at:\/\//i;

/** Which ingest path(s) a run repairs. */
type RepairPath = 'atproto' | 'bridgy' | 'all';

/** Per-post repair outcome. */
type RepairOutcome = 'repaired' | 'unchanged' | 'gone' | 'fetch-failed' | 'skipped';

interface Flags {
  dryRun: boolean;
  limit?: number;
  path: RepairPath;
  actor?: string;
  concurrency: number;
}

/** The lean Post fields the repair reads for both paths. */
interface StoredPostRow {
  _id: mongoose.Types.ObjectId;
  oxyUserId?: string | null;
  type?: string;
  hashtags?: string[];
  mentions?: string[];
  parentPostId?: string | null;
  threadId?: string | null;
  quoteOf?: string | null;
  content?: {
    variants?: PostContentVariant[];
    media?: MediaItem[];
    attachments?: ExtractedMediaAttachment[];
  } | null;
  federation?: {
    activityId?: string;
    actorUri?: string;
    url?: string;
    sensitive?: boolean;
    spoilerText?: string;
  } | null;
}

/** The lean `FederatedActor` fields the handle repair reads. */
interface FederatedActorRow {
  acct: string;
  username: string;
  domain: string;
}

interface Counters {
  scanned: number;
  repaired: number;
  unchanged: number;
  gone: number;
  fetchFailed: number;
  skipped: number;
}

interface ActorCounters {
  scanned: number;
  repaired: number;
  unchanged: number;
  missing: number;
  failed: number;
}

/** The projection shared by both path scans. */
const POST_PROJECTION: Record<string, 1> = {
  _id: 1,
  oxyUserId: 1,
  type: 1,
  hashtags: 1,
  mentions: 1,
  parentPostId: 1,
  threadId: 1,
  quoteOf: 1,
  'content.variants': 1,
  'content.media': 1,
  'content.attachments': 1,
  federation: 1,
};

// --- argv parsing (plain, mirrors reingestEmptyFederatedPosts) ---------------

/** Read the value of `--flag <value>` / `--flag=value` from argv. */
function readFlagValue(argv: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === name) return argv[i + 1];
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

function parseFlags(argv: string[]): Flags {
  const dryRun = argv.includes('--dry-run');

  const rawLimit = readFlagValue(argv, '--limit');
  let limit: number | undefined;
  if (rawLimit !== undefined) {
    const parsed = Number.parseInt(rawLimit, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`--limit must be a positive integer (got "${rawLimit}")`);
    }
    limit = parsed;
  }

  const rawPath = (readFlagValue(argv, '--path') ?? 'all').toLowerCase();
  if (rawPath !== 'atproto' && rawPath !== 'bridgy' && rawPath !== 'all') {
    throw new Error(`--path must be one of atproto|bridgy|all (got "${rawPath}")`);
  }

  const actor = readFlagValue(argv, '--actor')?.trim() || undefined;

  const rawConcurrency = readFlagValue(argv, '--concurrency');
  let concurrency = DEFAULT_CONCURRENCY;
  if (rawConcurrency !== undefined) {
    const parsed = Number.parseInt(rawConcurrency, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`--concurrency must be a positive integer (got "${rawConcurrency}")`);
    }
    concurrency = Math.min(parsed, MAX_CONCURRENCY);
  }

  return { dryRun, limit, path: rawPath, actor, concurrency };
}

// --- pure diff helpers -------------------------------------------------------

/** Order-independent equality of two string arrays (treated as sets/bags). */
function sortedStringArrayEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((value, i) => value === sb[i]);
}

/**
 * A stable signature of a media set keyed by the load-bearing identity fields
 * (`id` + `type` + `alt`). Deliberately excludes the enrichment metadata
 * (`width`/`orientation`/…) that `PostCreationService` layers on AFTER ingest, so
 * comparing a freshly-materialized set against a stored (enriched) set does not
 * churn — only a genuinely different attachment set (a recovered image, a
 * reclassified image↔video, an added/removed item) changes the signature.
 */
function mediaSignature(media: readonly MediaItem[] | undefined | null): string {
  if (!media || media.length === 0) return '';
  return media
    .map((item) => `${item.id} ${item.type} ${item.alt ?? ''}`)
    .sort()
    .join('');
}

/**
 * Repair the BODY text of the stored variants from freshly-mapped bodies, WITHOUT
 * disturbing the stored language tags, `source`, or `createdAt`. Returns the new
 * variant array when a body actually changed, or `undefined` when nothing changed
 * (or when there is nothing to safely repair).
 *
 * Non-destructive by construction:
 *  - a post that has no stored body variant is left alone — that is the empty-post
 *    reingest script's job, not this one;
 *  - a fresh mapping that produced NO body never blanks a content-bearing post;
 *  - only the text is swapped in, so the classifier-detected/author-declared tag a
 *    stored variant carries is preserved (never reset by the re-map).
 *
 * Variants are aligned by index — the federated ingest writes them in a
 * deterministic order (primary first). A structural mismatch (variant count
 * differs, only reachable for a rare multilingual bridged note) repairs the
 * PRIMARY body text alone and leaves every other stored variant intact.
 */
function repairVariantText(
  freshTexts: readonly string[],
  stored: readonly PostContentVariant[] | undefined | null,
): PostContentVariant[] | undefined {
  if (!stored || stored.length === 0) return undefined;
  if (freshTexts.length === 0) return undefined;

  if (freshTexts.length !== stored.length) {
    const freshPrimary = freshTexts[0];
    if (!freshPrimary || freshPrimary === stored[0].text) return undefined;
    return [{ ...stored[0], text: freshPrimary }, ...stored.slice(1)];
  }

  let changed = false;
  const next = stored.map((variant, i) => {
    const freshText = freshTexts[i];
    if (typeof freshText === 'string' && freshText.length > 0 && freshText !== variant.text) {
      changed = true;
      return { ...variant, text: freshText };
    }
    return variant;
  });
  return changed ? next : undefined;
}

/** The post `type` a media set implies (mirrors the inbox `Update` derivation). */
function postTypeFromMedia(media: readonly MediaItem[]): PostType {
  if (media.length === 0) return PostType.TEXT;
  return media.some((item) => item.type === 'video') ? PostType.VIDEO : PostType.IMAGE;
}

// --- brid.gy (ActivityPub) path ---------------------------------------------

/** Outcome of re-fetching a brid.gy post's source AP object. */
type ApFetchOutcome =
  | { kind: 'ok'; object: Record<string, unknown> }
  | { kind: 'gone' }
  | { kind: 'error' };

/**
 * Re-fetch a brid.gy post's source AP object with a signed GET, classifying the
 * result so the caller can distinguish a permanently-removed object (`gone`) from
 * a transient failure (`error`). Mirrors `reingestEmptyFederatedPosts`.
 */
async function fetchApObject(url: string): Promise<ApFetchOutcome> {
  let res: Response;
  try {
    res = await signedFetch(url, AP_CONTENT_TYPE);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[reingestBlueskyPosts] AP fetch error for ${url}: ${message}`);
    return { kind: 'error' };
  }

  if (GONE_STATUS_CODES.has(res.status)) return { kind: 'gone' };
  if (!res.ok) {
    logger.warn(`[reingestBlueskyPosts] AP fetch failed for ${url}: ${res.status} ${res.statusText}`);
    return { kind: 'error' };
  }

  try {
    const object: unknown = await res.json();
    if (!object || typeof object !== 'object' || Array.isArray(object)) {
      logger.warn(`[reingestBlueskyPosts] AP fetch returned non-object for ${url}`);
      return { kind: 'error' };
    }
    return { kind: 'ok', object: object as Record<string, unknown> };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[reingestBlueskyPosts] AP parse error for ${url}: ${message}`);
    return { kind: 'error' };
  }
}

/**
 * Repair one brid.gy AP post: re-map its source object through the fresh inbox-edit
 * path and write only the fields (`content.variants` text, media/attachments,
 * hashtags, mentions, type) that actually changed.
 */
async function repairBridgyPost(post: StoredPostRow, flags: Flags): Promise<RepairOutcome> {
  const sourceUrl = post.federation?.url || post.federation?.activityId;
  if (!sourceUrl) return 'skipped';

  const fetched = await fetchApObject(sourceUrl);
  if (fetched.kind === 'error') return 'fetch-failed';
  if (fetched.kind === 'gone') return 'gone'; // content-bearing — leave, never delete

  // Fresh ingest recipe: resolve mentions, splice the `[mention:<id>]` placeholders
  // into the body, then extract the storable fields. Mentions are resolved
  // LOOKUP-ONLY (`resolveInboundMentionsExisting`) — a repair must never fetch or
  // MINT a federated actor for a mentioned account, so an unknown mention is left
  // as raw text rather than polluting the federated index with a ghost user.
  const mentionResult = await resolveInboundMentionsExisting(fetched.object);
  const noteObject = applyMentionPlaceholders(fetched.object, mentionResult.anchorMap);
  const built = await buildFederatedNoteContentForEdit(noteObject, post.oxyUserId ?? null, {
    activityId: post.federation?.activityId,
    actorUri: post.federation?.actorUri,
  });

  const setOps: Record<string, unknown> = {};
  const changedFields: string[] = [];

  // Body: repair the variant text only (tags/source preserved).
  const repairedVariants = repairVariantText(built.variants.map((v) => v.text), post.content?.variants);
  if (repairedVariants) {
    setOps['content.variants'] = repairedVariants;
    changedFields.push('content.variants');
  }

  // Media: additive/reclassify only. Recover images the old check dropped, or a
  // reclassified item — but never DROP media in a repair (a fresh empty set on a
  // post that has media is treated as an upstream edit, out of scope here).
  if (built.media.length > 0 && mediaSignature(built.media) !== mediaSignature(post.content?.media)) {
    setOps['content.media'] = built.media;
    setOps['content.attachments'] = built.attachments;
    changedFields.push('content.media');
    const derivedType = postTypeFromMedia(built.media);
    if (post.type !== derivedType) {
      setOps.type = derivedType;
      changedFields.push('type');
    }
  }

  // Hashtags + mentions: the fresh extraction is authoritative (a fixed anchor now
  // yields a real `#tag` / a resolved `[mention:<id>]`).
  if (!sortedStringArrayEqual(built.hashtags, post.hashtags ?? [])) {
    setOps.hashtags = built.hashtags;
    changedFields.push('hashtags');
  }
  if (!sortedStringArrayEqual(mentionResult.ids, post.mentions ?? [])) {
    setOps.mentions = mentionResult.ids;
    changedFields.push('mentions');
  }

  if (changedFields.length === 0) return 'unchanged';

  logger.info(
    `[reingestBlueskyPosts] ${flags.dryRun ? 'WOULD repair' : 'repairing'} bridgy post ${String(post._id)} ` +
      `(${changedFields.join(', ')})`,
  );
  if (!flags.dryRun) {
    await Post.updateOne({ _id: post._id }, { $set: setOps });
  }
  return 'repaired';
}

// --- direct atproto path -----------------------------------------------------

/**
 * Repair one direct-atproto post: re-fetch its current PostView, re-run
 * `post.mapper`, and write only the changed fields (`content.variants` text,
 * hashtags, mentions, and the reply/quote structural links). Media and sensitivity
 * are out of #439's atproto scope and are left untouched.
 */
async function repairAtprotoPost(post: StoredPostRow, flags: Flags): Promise<RepairOutcome> {
  const atUri = post.federation?.activityId;
  const did = post.federation?.actorUri;
  const ownerOxyUserId = post.oxyUserId;
  if (!atUri || !did || !ownerOxyUserId) return 'skipped';

  const result = await refetchAtprotoPostForRepair(atUri, did, ownerOxyUserId);
  if (result.kind === 'error') return 'fetch-failed';
  if (result.kind === 'gone') return 'gone'; // content-bearing — leave, never delete

  // Reproduce the storage transform the Post pre-save hook applies at ingest
  // (`normalizePostHashtags(primary.text, hashtags)`) so the comparison is against
  // the exact values a fresh import would have stored — no false diff, no churn.
  const { content: targetText, hashtags: targetHashtags } = normalizePostHashtags(
    result.post.text,
    result.post.hashtags ?? [],
  );
  const freshMentions = result.post.mentions ?? [];

  const setOps: Record<string, unknown> = {};
  const changedFields: string[] = [];

  const repairedVariants = repairVariantText([targetText], post.content?.variants);
  if (repairedVariants) {
    setOps['content.variants'] = repairedVariants;
    changedFields.push('content.variants');
  }
  if (!sortedStringArrayEqual(targetHashtags, post.hashtags ?? [])) {
    setOps.hashtags = targetHashtags;
    changedFields.push('hashtags');
  }
  if (!sortedStringArrayEqual(freshMentions, post.mentions ?? [])) {
    setOps.mentions = freshMentions;
    changedFields.push('mentions');
  }

  // Reply/quote links are ADDITIVE: set them when the fresh resolution found a
  // local target that differs from what is stored (the #439 bug left them null).
  // Never null-out an existing link on a transient miss.
  const { parentPostId, threadId, quoteOf } = result.links;
  if (parentPostId && parentPostId !== (post.parentPostId ?? undefined)) {
    setOps.parentPostId = parentPostId;
    changedFields.push('parentPostId');
    if (threadId && threadId !== (post.threadId ?? undefined)) {
      setOps.threadId = threadId;
      changedFields.push('threadId');
    }
  }
  if (quoteOf && quoteOf !== (post.quoteOf ?? undefined)) {
    setOps.quoteOf = quoteOf;
    changedFields.push('quoteOf');
  }

  if (changedFields.length === 0) return 'unchanged';

  logger.info(
    `[reingestBlueskyPosts] ${flags.dryRun ? 'WOULD repair' : 'repairing'} atproto post ${String(post._id)} ` +
      `(${changedFields.join(', ')})`,
  );
  if (!flags.dryRun) {
    await Post.updateOne({ _id: post._id }, { $set: setOps });
  }
  return 'repaired';
}

// --- actor handle repair (atproto only, deduped per distinct DID) ------------

/**
 * Repair the doubled-handle bug on each distinct atproto actor referenced by the
 * scanned posts. The `splitHandle` fix lives on the `FederatedActor` doc, so this
 * runs ONCE per DID (deduped), never per post. Detection is a pure comparison of
 * the stored `domain` against `splitHandle(acct).domain`; the actual repair re-runs
 * the shared profile upsert (`fetchAndUpsertAtprotoProfile`), which re-derives the
 * handle AND re-resolves the Oxy user with the corrected `local@domain` username.
 */
async function repairActorHandles(
  dids: ReadonlySet<string>,
  flags: Flags,
  counters: ActorCounters,
): Promise<void> {
  for (const did of dids) {
    counters.scanned += 1;
    const actor = await FederatedActor.findOne({ uri: did }, { acct: 1, username: 1, domain: 1 }).lean<
      FederatedActorRow | null
    >();
    if (!actor || !actor.acct) {
      counters.missing += 1;
      continue;
    }

    const expected = splitHandle(actor.acct);
    if (expected.domain === actor.domain) {
      counters.unchanged += 1;
      continue;
    }

    logger.info(
      `[reingestBlueskyPosts] ${flags.dryRun ? 'WOULD repair' : 'repairing'} actor ${did} handle: ` +
        `${actor.username}@${actor.domain} → ${expected.federatedUsername}`,
    );
    if (flags.dryRun) {
      counters.repaired += 1;
      continue;
    }

    const refreshed = await fetchAndUpsertAtprotoProfile(did);
    if (refreshed) counters.repaired += 1;
    else counters.failed += 1;
  }
}

// --- scan driver -------------------------------------------------------------

/** Build the base Mongo filter for one path (plus the optional single-actor scope). */
function buildFilter(path: 'bridgy' | 'atproto', actor: string | undefined): Record<string, unknown> {
  const filter: Record<string, unknown> =
    path === 'bridgy'
      ? {
          type: { $ne: PostType.BOOST },
          $or: [
            { 'federation.actorUri': { $regex: BRIDGY_HOST_RE } },
            { 'federation.activityId': { $regex: BRIDGY_HOST_RE } },
            { 'federation.url': { $regex: BRIDGY_HOST_RE } },
          ],
        }
      : {
          type: { $ne: PostType.BOOST },
          'federation.activityId': { $regex: AT_URI_PREFIX_RE },
        };
  if (actor) filter['federation.actorUri'] = actor;
  return filter;
}

/** A mutable budget shared across both path scans (the `--limit` canary cap). */
interface Budget {
  remaining: number | undefined;
}

/** Distinct rejection raised by {@link withRepairTimeout} when a post exceeds the cap. */
class RepairTimeoutError extends Error {
  constructor(ms: number) {
    super(`repair exceeded ${ms}ms hard timeout`);
    this.name = 'RepairTimeoutError';
  }
}

/**
 * Race one post's repair against a hard timeout so a single hung remote can never
 * freeze the batch. The timer is ALWAYS cleared when the repair settles (win or
 * lose the race), so no timer is leaked. Losing the race is safe: a repair writes
 * its `Post.updateOne` only as the LAST step after every await resolves, so a
 * genuinely-hung repair never reaches the write — the post is simply left untouched
 * for a later run, exactly like any other `fetch-failed`.
 */
function withRepairTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RepairTimeoutError(ms)), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Scan one path with a stable ascending `_id` cursor and repair each post. Forward-
 * only: a repair only ever changes fields the filter does not select on, so no post
 * is revisited or skipped across pages. Collects each atproto DID for the deduped
 * actor-handle repair. Stops early when the shared `--limit` budget is exhausted.
 */
async function scanPath(
  path: 'bridgy' | 'atproto',
  flags: Flags,
  counters: Counters,
  budget: Budget,
  atprotoDids: Set<string>,
): Promise<void> {
  const baseFilter = buildFilter(path, flags.actor);
  const total = await Post.countDocuments(baseFilter);
  logger.info(`[reingestBlueskyPosts] ${path}: ${total} candidate posts to scan${flags.actor ? ` (actor ${flags.actor})` : ''}`);
  if (total === 0) return;

  const repair = path === 'bridgy' ? repairBridgyPost : repairAtprotoPost;
  let lastId: mongoose.Types.ObjectId | null = null;

  for (;;) {
    if (budget.remaining !== undefined && budget.remaining <= 0) break;

    const pageFilter: Record<string, unknown> = { ...baseFilter };
    if (lastId) pageFilter._id = { $gt: lastId };

    const pageLimit =
      budget.remaining !== undefined ? Math.min(PAGE_SIZE, budget.remaining) : PAGE_SIZE;
    const page = await Post.find(pageFilter, POST_PROJECTION)
      .sort({ _id: 1 })
      .limit(pageLimit)
      .lean<StoredPostRow[]>();
    if (page.length === 0) break;

    // The page is already sliced to at most the remaining budget (`pageLimit`), so
    // repairing the WHOLE page in a bounded pool can never overshoot `--limit`.
    // Each post's work stays wrapped in its per-post hard timeout, so one hung
    // remote still cannot stall the pool beyond `REPAIR_TIMEOUT_MS`.
    const settledResults = await mapWithConcurrency(page, flags.concurrency, (post) =>
      withRepairTimeout(repair(post, flags), REPAIR_TIMEOUT_MS),
    );

    // Tally sequentially in `_id` order AFTER the pool drains: every counter,
    // the shared budget, and the DID set are mutated exactly once per post on a
    // single call stack, so no concurrent update can race or double-count.
    for (let i = 0; i < page.length; i++) {
      const post = page[i];
      counters.scanned += 1;
      if (budget.remaining !== undefined) budget.remaining -= 1;

      if (path === 'atproto' && post.federation?.actorUri) {
        atprotoDids.add(post.federation.actorUri);
      }

      const settled = settledResults[i];
      let outcome: RepairOutcome;
      if (settled.status === 'fulfilled') {
        outcome = settled.value;
      } else {
        // One bad post never aborts the run; treat it as a transient failure so a
        // later run can still recover it. A timeout is the defence-in-depth guard
        // against an unbounded await hanging the whole sweep.
        const err = settled.reason;
        if (err instanceof RepairTimeoutError) {
          logger.warn(
            `[reingestBlueskyPosts] ${path} post ${String(post._id)} repair timed out after ${REPAIR_TIMEOUT_MS}ms — skipping`,
          );
        } else {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(`[reingestBlueskyPosts] ${path} post ${String(post._id)} repair threw: ${message}`);
        }
        outcome = 'fetch-failed';
      }

      switch (outcome) {
        case 'repaired':
          counters.repaired += 1;
          break;
        case 'unchanged':
          counters.unchanged += 1;
          break;
        case 'gone':
          counters.gone += 1;
          break;
        case 'fetch-failed':
          counters.fetchFailed += 1;
          break;
        case 'skipped':
          counters.skipped += 1;
          break;
      }
    }

    lastId = page[page.length - 1]._id;
    logger.info(
      `[reingestBlueskyPosts] ${path} progress: scanned ${counters.scanned}, repaired ${counters.repaired}, ` +
        `unchanged ${counters.unchanged}, gone ${counters.gone}, fetchFailed ${counters.fetchFailed}, skipped ${counters.skipped}`,
    );
  }
}

// --- entrypoint --------------------------------------------------------------

async function reingestBlueskyPosts(): Promise<void> {
  const startedAt = Date.now();
  const flags = parseFlags(process.argv.slice(2));

  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/mention';
  const dbName = `mention-${process.env.NODE_ENV || 'development'}`;

  const counters: Counters = { scanned: 0, repaired: 0, unchanged: 0, gone: 0, fetchFailed: 0, skipped: 0 };
  const actorCounters: ActorCounters = { scanned: 0, repaired: 0, unchanged: 0, missing: 0, failed: 0 };
  const budget: Budget = { remaining: flags.limit };
  const atprotoDids = new Set<string>();

  try {
    await mongoose.connect(mongoUri, { dbName });
    logger.info(
      `[reingestBlueskyPosts] connected to MongoDB (${dbName}) — mode: ${flags.dryRun ? 'DRY-RUN' : 'LIVE'}, ` +
        `path: ${flags.path}, concurrency: ${flags.concurrency}${flags.limit !== undefined ? `, limit: ${flags.limit}` : ''}`,
    );

    if (flags.path === 'bridgy' || flags.path === 'all') {
      await scanPath('bridgy', flags, counters, budget, atprotoDids);
    }
    if (flags.path === 'atproto' || flags.path === 'all') {
      await scanPath('atproto', flags, counters, budget, atprotoDids);
      await repairActorHandles(atprotoDids, flags, actorCounters);
    }

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[reingestBlueskyPosts] done (${flags.dryRun ? 'DRY-RUN' : 'LIVE'}, ${elapsedSeconds}s): ` +
        `scanned ${counters.scanned}, repaired ${counters.repaired}, unchanged ${counters.unchanged}, ` +
        `gone ${counters.gone}, fetchFailed ${counters.fetchFailed}, skipped ${counters.skipped} | ` +
        `actors scanned ${actorCounters.scanned}, repaired ${actorCounters.repaired}, ` +
        `unchanged ${actorCounters.unchanged}, missing ${actorCounters.missing}, failed ${actorCounters.failed}`,
    );

    await mongoose.disconnect();
  } catch (error) {
    logger.error('[reingestBlueskyPosts] failed', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

if (require.main === module) {
  // Exit deterministically: imported singletons (BullMQ Redis connections, media
  // cache workers) can keep the event loop alive, so the process would otherwise
  // sit RUNNING after the work completes. Mirrors the other one-shot scripts.
  reingestBlueskyPosts()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('[reingestBlueskyPosts] unhandled failure', error);
      process.exit(1);
    });
}

export default reingestBlueskyPosts;
