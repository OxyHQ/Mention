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
 *      HANDLE fix (`splitHandle`: a default handle drops its redundant suffix,
 *      `skylee1.bsky.social` → `@skylee1@bsky.social`, while a custom domain keeps
 *      its whole handle, `gothamist.com` → `@gothamist.com@bsky.social`) lives on
 *      the `FederatedActor` doc, so it is repaired ONCE per distinct actor
 *      (deduped), not per post.
 *
 * HOW EACH PATH RE-FETCHES + RE-MAPS + DIFFS
 *   Both paths re-derive the SAME storable fields fresh ingest would produce, then
 *   compare them against what is stored and WRITE ONLY the fields that actually
 *   changed (targeted column writes plus one content replace). A post whose fresh
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
 *                          Post docs nor the FederatedActor handle repair).
 *                          Mention resolution is lookup-only and media stays on
 *                          its remote URL: no Oxy identity/media persistence and
 *                          no cache enqueue occurs during the preview.
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
 *   CONFIRM_ADMIN_MUTATION=reingestBlueskyPosts \
 *     bun packages/backend/dist/src/scripts/reingestBlueskyPosts.js --path bridgy --limit 50
 *
 * RUN OVER THE SSM TUNNEL (prod Mongo forwarded to 127.0.0.1:47017):
 *   MONGODB_URI='mongodb://127.0.0.1:47017/?directConnection=true' \
 *   NODE_ENV=production \
 *   bun packages/backend/src/scripts/reingestBlueskyPosts.ts --dry-run --limit 20
 *   (drop --dry-run to write; the tunnel is fine for this cursor-paged sweep.)
 */

import mongoose from 'mongoose';
import {
  PostType,
  type MediaItem,
  type StoredPostContent,
} from '@mention/shared-types';
import { and, asc, count, eq, gt, ilike, ne, or, type SQL } from 'drizzle-orm';
import { connectPostgres, getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';
import {
  findPostRecords,
  replacePostContent,
  updatePostRecord,
} from '../db/posts/postRepository';
import type { PostRecord } from '../db/posts/postRecord';
import { findActorByUri } from '../db/federation/actorRepository';
import { logger } from '../utils/logger';
import { normalizePostHashtags } from '../utils/textProcessing';
import { buildFederatedNoteContentForEdit } from '../connectors/activitypub/apPostContent';
import { applyMentionPlaceholders, resolveInboundMentionsExisting } from '../connectors/activitypub/apMentions';
import { signedFetch } from '../connectors/activitypub/helpers';
import { AP_CONTENT_TYPE } from '../connectors/activitypub/constants';
import { refetchAtprotoPostForRepair } from '../connectors/atproto/post.mapper';
import { fetchAndUpsertAtprotoProfile, splitHandle } from '../connectors/atproto/profile.mapper';
import { mapWithConcurrency, DEFAULT_CONCURRENCY, MAX_CONCURRENCY } from '../utils/concurrency';
import { repairVariantText } from './lib/variantTextRepair';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import {
  assertAdminRunComplete,
  closeAdminScriptResources,
} from './lib/adminScriptLifecycle';

/** Posts scanned per page (stable ascending `id` cursor pagination). */
const PAGE_SIZE = 500;

/**
 * Hard per-post wall-clock cap used only by the side-effect-free preview. Live
 * repairs rely on the clients' own request deadlines and are awaited fully so a
 * non-cancellable Promise cannot mutate after being reported as timed out.
 */
const REPAIR_TIMEOUT_MS = 45_000;

/** HTTP statuses that mean the remote object is permanently gone. */
const GONE_STATUS_CODES = new Set([404, 410]);

/** A brid.gy-hosted federation URL (the AP object / actor lives on `bsky.brid.gy`). */
const BRIDGY_HOST = 'bsky.brid.gy';

/** A bare atproto AT-URI (`at://<authority>/<collection>/<rkey>`) activity id. */
const AT_URI_PREFIX = 'at://';

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
type StoredPostRow = PostRecord;

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
    .map((item) => `${item.id}\x00${item.type}\x00${item.alt ?? ''}`)
    .sort()
    .join('\x01');
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
    logger.warn('[reingestBlueskyPosts] ActivityPub fetch failed', { error: err });
    return { kind: 'error' };
  }

  if (GONE_STATUS_CODES.has(res.status)) return { kind: 'gone' };
  if (!res.ok) {
    logger.warn('[reingestBlueskyPosts] ActivityPub fetch returned an error status', {
      status: res.status,
    });
    return { kind: 'error' };
  }

  try {
    const object: unknown = await res.json();
    if (!object || typeof object !== 'object' || Array.isArray(object)) {
      logger.warn('[reingestBlueskyPosts] ActivityPub fetch returned a non-object payload');
      return { kind: 'error' };
    }
    return { kind: 'ok', object: object as Record<string, unknown> };
  } catch (err) {
    logger.warn('[reingestBlueskyPosts] ActivityPub payload parsing failed', { error: err });
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
    materializeMedia: !flags.dryRun,
  });

  const changedFields: string[] = [];
  const content: StoredPostContent = { ...post.content };
  let nextType = post.type;
  let nextHashtags = post.hashtags;
  let nextMentions = post.mentions;

  // Body: repair the variant text only (tags/source preserved).
  const repairedVariants = repairVariantText(built.variants.map((v) => v.text), post.content.variants);
  if (repairedVariants) {
    content.variants = repairedVariants;
    changedFields.push('content.variants');
  }

  // Media: additive/reclassify only. Recover images the old check dropped, or a
  // reclassified item — but never DROP media in a repair (a fresh empty set on a
  // post that has media is treated as an upstream edit, out of scope here).
  if (built.media.length > 0 && mediaSignature(built.media) !== mediaSignature(post.content.media)) {
    content.media = built.media;
    content.attachments = built.attachments;
    changedFields.push('content.media');
    const derivedType = postTypeFromMedia(built.media);
    if (post.type !== derivedType) {
      nextType = derivedType;
      changedFields.push('type');
    }
  }

  // Hashtags + mentions: the fresh extraction is authoritative (a fixed anchor now
  // yields a real `#tag` / a resolved `[mention:<id>]`).
  if (!sortedStringArrayEqual(built.hashtags, post.hashtags)) {
    nextHashtags = built.hashtags;
    changedFields.push('hashtags');
  }
  if (!sortedStringArrayEqual(mentionResult.ids, post.mentions)) {
    nextMentions = mentionResult.ids;
    changedFields.push('mentions');
  }

  if (changedFields.length === 0) return 'unchanged';

  logger.info('[reingestBlueskyPosts] bridgy post repair prepared', {
    dryRun: flags.dryRun,
    changedFieldCount: changedFields.length,
  });
  if (!flags.dryRun) {
    await applyPostRepair(post, {
      content,
      type: nextType,
      hashtags: nextHashtags,
      mentions: nextMentions,
    });
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

  const result = await refetchAtprotoPostForRepair(atUri, did, ownerOxyUserId, {
    allowIdentityMutation: !flags.dryRun,
  });
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

  const changedFields: string[] = [];
  const content: StoredPostContent = { ...post.content };
  let nextHashtags = post.hashtags;
  let nextMentions = post.mentions;
  const links: { parentPostId?: string; threadId?: string; quoteOf?: string } = {};

  const repairedVariants = repairVariantText([targetText], post.content.variants);
  if (repairedVariants) {
    content.variants = repairedVariants;
    changedFields.push('content.variants');
  }
  if (!sortedStringArrayEqual(targetHashtags, post.hashtags)) {
    nextHashtags = targetHashtags;
    changedFields.push('hashtags');
  }
  if (!sortedStringArrayEqual(freshMentions, post.mentions)) {
    nextMentions = freshMentions;
    changedFields.push('mentions');
  }

  // Reply/quote links are ADDITIVE: set them when the fresh resolution found a
  // local target that differs from what is stored (the #439 bug left them null).
  // Never null-out an existing link on a transient miss.
  const { parentPostId, threadId, quoteOf } = result.links;
  if (parentPostId && parentPostId !== (post.parentPostId ?? undefined)) {
    links.parentPostId = parentPostId;
    changedFields.push('parentPostId');
    if (threadId && threadId !== (post.threadId ?? undefined)) {
      links.threadId = threadId;
      changedFields.push('threadId');
    }
  }
  if (quoteOf && quoteOf !== (post.quoteOf ?? undefined)) {
    links.quoteOf = quoteOf;
    changedFields.push('quoteOf');
  }

  if (changedFields.length === 0) return 'unchanged';

  logger.info('[reingestBlueskyPosts] atproto post repair prepared', {
    dryRun: flags.dryRun,
    changedFieldCount: changedFields.length,
  });
  if (!flags.dryRun) {
    await applyPostRepair(post, {
      content,
      hashtags: nextHashtags,
      mentions: nextMentions,
      links,
    });
  }
  return 'repaired';
}

// --- actor handle repair (atproto only, deduped per distinct DID) ------------

/**
 * Repair the handle-rendering bugs on each distinct atproto actor referenced by the
 * scanned posts. The `splitHandle` fix lives on the `FederatedActor` doc, so this
 * runs ONCE per DID (deduped), never per post. Detection is a pure comparison of the
 * stored `${username}@${domain}` against the re-derived `splitHandle(acct).federatedUsername`
 * — comparing the domain ALONE would miss a `.bsky.social` actor, whose domain stays
 * `bsky.social` while its username shortens (`skylee1.bsky.social` → `skylee1`). The
 * actual repair re-runs the shared profile upsert (`fetchAndUpsertAtprotoProfile`),
 * which re-derives the handle AND re-resolves the Oxy user with the corrected
 * `local@domain` username.
 */
async function repairActorHandles(
  dids: ReadonlySet<string>,
  flags: Flags,
  counters: ActorCounters,
): Promise<void> {
  for (const did of dids) {
    counters.scanned += 1;
    const actor = await findActorByUri(did);
    if (!actor || !actor.acct) {
      counters.missing += 1;
      continue;
    }

    const expected = splitHandle(actor.acct);
    if (expected.federatedUsername === `${actor.username}@${actor.domain}`) {
      counters.unchanged += 1;
      continue;
    }

    logger.info('[reingestBlueskyPosts] actor handle repair prepared', {
      dryRun: flags.dryRun,
    });
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
function buildFilter(path: 'bridgy' | 'atproto', actor: string | undefined): SQL {
  // `ILIKE` with the same literals the regexes match, which is exact here because
  // both patterns are plain substrings — no metacharacter but the escaped `.`,
  // which `ILIKE` treats literally anyway. `AT_URI_PREFIX_RE` is anchored, so its
  // `ILIKE` has no leading `%`.
  const conditions: SQL[] = [ne(posts.type, PostType.BOOST)];
  if (path === 'bridgy') {
    conditions.push(
      or(
        ilike(posts.federationActorUri, `%${BRIDGY_HOST}%`),
        ilike(posts.federationActivityId, `%${BRIDGY_HOST}%`),
        ilike(posts.federationUrl, `%${BRIDGY_HOST}%`),
      ) as SQL,
    );
  } else {
    conditions.push(ilike(posts.federationActivityId, `${AT_URI_PREFIX}%`));
  }
  if (actor) conditions.push(eq(posts.federationActorUri, actor));
  return and(...conditions) as SQL;
}

/**
 * Persist one repair.
 *
 * Content goes through `replacePostContent` — the child tables carry a dense
 * `UNIQUE (post_id, position)`, so a reordering repair collides with itself
 * mid-update unless the old rows are gone first. The scalar columns are a
 * separate, ordinary update.
 *
 * `is_reply` is deliberately NOT touched when a `parentPostId` link is attached:
 * the row already carried `federation.inReplyTo` at insert, so the discriminator
 * was stamped then. This pass attaches the LOCAL link the original ingest could
 * not resolve; it does not change what the post was written as.
 */
async function applyPostRepair(
  post: StoredPostRow,
  patch: {
    content: StoredPostContent;
    type?: PostType;
    hashtags: string[];
    mentions: string[];
    links?: { parentPostId?: string; threadId?: string; quoteOf?: string };
  },
): Promise<void> {
  await updatePostRecord(post.id, { hashtags: patch.hashtags });
  const scalars: Record<string, unknown> = {};
  if (patch.type !== undefined && patch.type !== post.type) scalars.type = patch.type;
  if (patch.links?.parentPostId) scalars.parentPostId = patch.links.parentPostId;
  if (patch.links?.threadId) scalars.threadId = patch.links.threadId;
  if (patch.links?.quoteOf) scalars.quoteOf = patch.links.quoteOf;
  if (Object.keys(scalars).length > 0) {
    await getDb().update(posts).set(scalars).where(eq(posts.id, post.id));
  }
  await replacePostContent(post.id, patch.content, patch.mentions);
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
 * Bound a side-effect-free preview. The timer is always cleared when the preview
 * settles; live repairs never use this non-cancelling race.
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
  const [totals] = await getDb().select({ count: count() }).from(posts).where(baseFilter);
  const total = totals?.count ?? 0;
  logger.info('[reingestBlueskyPosts] candidate posts selected', {
    sourceKind: path,
    count: total,
    narrowedScope: Boolean(flags.actor),
  });
  if (total === 0) return;

  const repair = path === 'bridgy' ? repairBridgyPost : repairAtprotoPost;
  let lastId: string | null = null;

  for (;;) {
    if (budget.remaining !== undefined && budget.remaining <= 0) break;

    const pageLimit =
      budget.remaining !== undefined ? Math.min(PAGE_SIZE, budget.remaining) : PAGE_SIZE;
    const page: StoredPostRow[] = await findPostRecords(
      lastId ? and(baseFilter, gt(posts.id, lastId)) : baseFilter,
      { orderBy: [asc(posts.id)], limit: pageLimit },
    );
    if (page.length === 0) break;

    // The page is already sliced to at most the remaining budget (`pageLimit`), so
    // repairing the WHOLE page in a bounded pool can never overshoot `--limit`.
    // A dry-run is side-effect free and may be timed out safely. Live repairs
    // are awaited to completion: a Promise.race cannot cancel a Mongo/Oxy write
    // and must never report timeout while mutation continues in the background.
    const settledResults = await mapWithConcurrency(page, flags.concurrency, (post) => {
      const work = repair(post, flags);
      return flags.dryRun ? withRepairTimeout(work, REPAIR_TIMEOUT_MS) : work;
    });

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
        // later run can still recover it. Only side-effect-free previews use the
        // local timeout; live paths rely on their bounded network clients.
        const err = settled.reason;
        if (err instanceof RepairTimeoutError) {
          logger.warn('[reingestBlueskyPosts] post repair timed out; skipping', {
            sourceKind: path,
            durationMs: REPAIR_TIMEOUT_MS,
          });
        } else {
          logger.warn('[reingestBlueskyPosts] post repair failed; skipping', {
            sourceKind: path,
            error: err,
          });
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

    lastId = page[page.length - 1].id;
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
    assertAdminMutationAllowed({
      scriptName: 'reingestBlueskyPosts',
      dryRun: flags.dryRun,
    });
    // BOTH stores. This script reads and writes `posts` directly through
    // `getDb()`, and `closeAdminScriptResources` was already closing a pool it
    // never opened — so every page died on "PostgreSQL is not connected".
    await Promise.all([mongoose.connect(mongoUri, { dbName }), connectPostgres()]);
    logger.info('[reingestBlueskyPosts] connected to MongoDB', {
      dryRun: flags.dryRun,
      sourceKind: flags.path,
      concurrency: flags.concurrency,
      limit: flags.limit,
    });

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

    assertAdminRunComplete('reingestBlueskyPosts', {
      fetchFailed: counters.fetchFailed,
      skipped: counters.skipped,
      actorMissing: actorCounters.missing,
      actorFailed: actorCounters.failed,
    });
  } catch (error) {
    logger.error('[reingestBlueskyPosts] failed', error);
    throw error;
  } finally {
    await closeAdminScriptResources();
    await mongoose.disconnect();
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
