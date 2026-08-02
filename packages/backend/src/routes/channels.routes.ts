/**
 * Channels API — the destination, its membership, and its followers.
 *
 * Two routers, because the two halves answer to different people:
 *
 *  - {@link publicChannelsRouter} is reader-agnostic: the directory, and one
 *    channel's public page. It resolves by id OR handle, so `/c/<handle>` works
 *    without the client first having to look the id up.
 *  - {@link default} (the authenticated router) is everything that writes, plus
 *    everything scoped to the caller.
 *
 * EXPRESS ORDERING: `/mine`, `/invites` and `/following` are declared BEFORE
 * `/:id`, or `:id` swallows them — the same dodge `routes/lanes.routes.ts` and
 * `routes/posts.ts` already make. All three are also RESERVED handles, which is
 * what lets the public param route hand them on instead of 404ing them.
 *
 * SEPARATION OF POWERS, enforced through `services/channelAccess` and nowhere
 * else, so "may publish" cannot come to mean one thing here and another in the
 * post controller:
 *  - the OWNER manages the channel, its profile and its membership;
 *  - a PUBLISHER publishes to it and nothing more;
 *  - a FOLLOWER only reads, and owns one switch of their own (`notify`).
 */

import { Router, type NextFunction, type Response } from 'express';
import { and, asc, desc, eq, inArray, lt, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  CHANNEL_HANDLE_MAX_LENGTH,
  CHANNEL_HANDLE_MIN_LENGTH,
  MAX_CHANNEL_DESCRIPTION_LENGTH,
  MAX_CHANNEL_MEMBERS,
  MAX_CHANNEL_TITLE_LENGTH,
  MAX_CHANNELS_PER_OWNER,
  normalizeChannelHandle,
  type Channel as ChannelDTO,
  type ChannelMemberSummary,
  type ChannelViewerState,
  type PostUser,
} from '@mention/shared-types';
import {
  requireOxyAuth as requireAuth,
  getRequiredOxyUserId as getAuthenticatedUserId,
  type OxyAuthRequest as AuthRequest,
} from '@oxyhq/core/server';
import { getDb } from '../db/postgres';
import { isLiveEntityId } from '../db/ids';
import { isUniqueViolation } from '../db/pgErrors';
import { channelFollows, channelMembers, channels } from '../db/schema/channels';
import {
  deleteChannelCascade,
  insertChannelWithOwner,
  updateChannelProfile,
  type ChannelRow,
} from '../db/channels/channelRepository';
import { resolveUserSummaries } from '../services/PostHydrationService';
import {
  bumpChannelCounter,
  canManageChannel,
  canViewChannel,
} from '../services/channelAccess';
import { serializeChannel } from '../services/channelDto';
import { MAX_CHANNEL_SEARCH_OFFSET, searchChannels } from '../services/channelSearch';
import { createNotification } from '../utils/notificationUtils';
import { validateBody, validateObjectId } from '../middleware/validate';
import { queryInt, queryString } from '../utils/queryParams';
import { channelReadRateLimiter, channelWriteRateLimiter } from '../middleware/security';
import { config } from '../config';
import { sendErrorResponse, sendSuccessResponse } from '../utils/apiHelpers';
import { logger } from '../utils/logger';

/** Directory page size, and the ceiling a caller's `limit` is clamped to. */
const DIRECTORY_PAGE_SIZE = 20;
const DIRECTORY_MAX_LIMIT = 50;

/** Member-list page size — bounded by {@link MAX_CHANNEL_MEMBERS} anyway. */
const MEMBER_PAGE_SIZE = MAX_CHANNEL_MEMBERS;

/**
 * Ceiling on the per-CALLER channel lists that have no cursor of their own:
 * `GET /channels/mine`, `GET /channels/invites`, and the `excludeFollowed` set.
 *
 * Nothing caps how many channels one person may join, be invited to, or follow,
 * so each of those reads is unbounded without this — and `/invites` is the one
 * that matters, because **third parties grow that set, not its owner**: anyone
 * who runs a channel can invite you, so the size of the read is not under the
 * victim's control. The `$in` / `$nin` these feed then inherit the same size.
 *
 * Truncating is the safe direction for all three. `excludeFollowed` is a
 * convenience on a directory, not a permission — a follow past the ceiling means
 * a channel the reader already follows shows up in the directory, never a channel
 * they cannot see. The other two are management views, and a caller with more
 * than this many needs pagination, which is a feature request rather than a
 * silent unbounded query.
 */
const MAX_CALLER_CHANNEL_ROWS = 500;

/**
 * The one unique constraint whose violation has to be CAUGHT rather than
 * absorbed by an `on conflict` clause: a taken handle is a 409, and a handle is
 * not the conflict target of any write here.
 *
 * Named, because `isUniqueViolation(error)` alone cannot tell "this handle is
 * taken" from an unrelated index on the same table — so a future index would
 * quietly start answering 409 for something else entirely (`db/pgErrors.ts`).
 * The membership and follow races are handled by naming their conflict target
 * instead, which needs no error inspection at all.
 */
const CHANNEL_HANDLE_UNIQUE = 'channels_handle_lower_key';

/**
 * Compliance limiters, production-gated like every other limiter in the repo so
 * tests and local development are unaffected. Spread into each route rather than
 * applied with `router.use`, so that a READ route never spends the write budget
 * and the grouping is legible at the route it governs.
 */
const readLimiters = config.runtime.isProduction ? [channelReadRateLimiter] : [];
const writeLimiters = config.runtime.isProduction ? [channelWriteRateLimiter] : [];

const handleSchema = z
  .string()
  .min(CHANNEL_HANDLE_MIN_LENGTH)
  .max(CHANNEL_HANDLE_MAX_LENGTH + 1)
  .transform((value) => value.trim());

/**
 * A channel's avatar/banner is a BARE Oxy file id, exactly as the DTO documents
 * — never a URL.
 *
 * Enforced rather than merely documented because Bloom's `ImageResolver` passes
 * `http:`/`https:`/`data:` through untouched: a URL stored here would be fetched
 * by every visitor to the channel's page AND by everyone who sees any post it
 * signs, handing the channel's owner the IP, User-Agent and Referer of readers
 * who never visited their host. The repo validates the same field the same loose
 * way elsewhere (`profileSettings.ts`), so this is not a hole opened here — it is
 * two lines that decline to inherit it on a NEW public surface.
 */
const mediaIdSchema = z
  .string()
  .regex(/^[a-f0-9]{24}$/, 'must be a bare Oxy file id, not a URL');

const createChannelSchema = z.object({
  handle: handleSchema,
  title: z.string().min(1, 'title is required').max(MAX_CHANNEL_TITLE_LENGTH).transform((v) => v.trim()),
  description: z.string().max(MAX_CHANNEL_DESCRIPTION_LENGTH).optional(),
  avatar: mediaIdSchema.optional(),
  banner: mediaIdSchema.optional(),
  signPosts: z.boolean().optional(),
});

const updateChannelSchema = z.object({
  handle: handleSchema.optional(),
  title: z.string().min(1).max(MAX_CHANNEL_TITLE_LENGTH).transform((v) => v.trim()).optional(),
  description: z.string().max(MAX_CHANNEL_DESCRIPTION_LENGTH).optional(),
  avatar: mediaIdSchema.optional(),
  banner: mediaIdSchema.optional(),
  signPosts: z.boolean().optional(),
});

const inviteMemberSchema = z.object({
  oxyUserId: z.string().min(1, 'oxyUserId is required').transform((v) => v.trim()),
});

const followSchema = z.object({
  notify: z.boolean(),
});

/**
 * Resolve a channel by its `_id` OR its handle — the one place both spellings are
 * accepted, so a URL can carry the readable one while the feed descriptor keeps
 * the stable one.
 *
 * The id is tried FIRST and the handle only on a miss: a handle is
 * `[a-z0-9_]{3,30}`, so a 24-character all-hex handle is legal, and refusing to
 * fall through would make that one handle permanently unreachable.
 *
 * The `ObjectId.isValid` gate that used to stand in front of the id lookup is
 * GONE. It only ever avoided a Mongoose `CastError`; a `text` id naming no row
 * already returns nothing, and after the cutover the gate would have SKIPPED the
 * id branch for every uuid v7 this instance mints — leaving a channel reachable
 * only by handle, and the `channel|<id>` descriptor's own page a 404.
 */
async function findChannelByIdOrHandle(idOrHandle: string): Promise<ChannelRow | null> {
  const db = getDb();
  const [byId] = await db.select().from(channels).where(eq(channels.id, idOrHandle)).limit(1);
  if (byId) return byId;
  const canonical = normalizeChannelHandle(idOrHandle);
  if (!canonical) return null;
  const [byHandle] = await db
    .select()
    .from(channels)
    .where(eq(channels.handleLower, canonical))
    .limit(1);
  return byHandle ?? null;
}

/**
 * The caller's own relationship to a channel, in two indexed point lookups.
 * `undefined` for an anonymous reader, whose DTO carries no `viewerState` at all
 * rather than one full of falses that a client could mistake for a real answer.
 */
async function loadViewerState(
  channelId: string,
  viewerId: string | undefined,
): Promise<ChannelViewerState | undefined> {
  if (!viewerId) return undefined;
  const db = getDb();
  const [follows, members] = await Promise.all([
    db
      .select({ notify: channelFollows.notify })
      .from(channelFollows)
      .where(and(eq(channelFollows.oxyUserId, viewerId), eq(channelFollows.channelId, channelId)))
      .limit(1),
    db
      .select({ role: channelMembers.role, status: channelMembers.status })
      .from(channelMembers)
      .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.oxyUserId, viewerId)))
      .limit(1),
  ]);
  const [follow] = follows;
  const [member] = members;
  return {
    isFollowing: follow != null,
    notify: follow?.notify === true,
    ...(member ? { role: member.role, memberStatus: member.status } : {}),
  };
}

/* ------------------------------------------------------------------------- */
/* Public                                                                     */
/* ------------------------------------------------------------------------- */

export const publicChannelsRouter = Router();

// This router is the ANONYMOUS-reachable surface — no account needed — so its
// limiter earns its place on merit rather than to quiet a scanner: the key
// generator falls back to a hashed IP, which is the only budget an unauthenticated
// caller has.
//
// Mounted PER ROUTE below, deliberately, and NOT with `router.use`. Two reasons,
// and the second is the one that cost a round:
//
//  1. `use(...[])` is `use()` with no arguments outside production, which Express
//     rejects outright ("argument handler is required"). A per-route spread always
//     still carries its handler.
//  2. A `use` guarded by `if (readLimiters.length > 0)` covers every route at
//     RUNTIME but is invisible to CodeQL's `js/missing-rate-limiting`, whose
//     dataflow looks for a limiter in the route's own chain and does not follow a
//     conditional. Runtime coverage and static coverage are different questions;
//     this shape answers both.

/**
 * GET /channels?cursor=<followerCount>_<id>&limit=&excludeFollowed=true
 * GET /channels?search=<term>&offset=&limit=&excludeFollowed=true
 *
 * ONE route, TWO questions, and which one is being asked is decided by the
 * presence of `search` — the same shape `GET /lists`, `GET /feeds` and
 * `GET /starter-packs` already take, which is why the search screen can drive
 * all four through one client facade.
 *
 *  - **BROWSE** (no `search`): the directory, most-followed first. Keyset-paged
 *    on `{ followerCount: -1, _id: -1 }`, which is exactly what
 *    `{ visibility, followerCount, _id }` stores — the same shape
 *    `GET /feeds/marketplace` uses, and for the same reason: a skip/limit
 *    directory duplicates and drops rows as follower counts move underneath it.
 *  - **SEARCH** (`search` present): ranked by relevance
 *    (`services/channelSearch.ts`), offset-paged.
 *
 * **The two pagination modes cannot be confused for one another**, which is the
 * failure worth engineering out — a cursor reinterpreted on the wrong axis
 * returns plausible, wrong rows on page 2 and nothing anywhere says so. They are
 * kept disjoint on BOTH sides: browse reads `cursor` and answers `nextCursor`,
 * search reads `offset` and answers `nextOffset`, and each mode ignores the
 * other's parameter outright. A client that sends the wrong one is served page 1
 * — a visible bug — never a silently misaligned page.
 *
 * Relevance paging is offset rather than keyset because the sort key is a
 * COMPUTED rank: a keyset would have to carry that rank in the cursor and
 * re-derive it identically on every page, which is a second definition of the
 * ranking waiting to drift from the first.
 *
 * `excludeFollowed` needs a caller, so it is a no-op for an anonymous reader
 * rather than an error — the directory is the same list either way. It applies
 * to BOTH modes: a documented parameter must not quietly stop meaning anything
 * because a search term appeared next to it.
 */
publicChannelsRouter.get('/', ...readLimiters, async (req: AuthRequest, res: Response) => {
  try {
    const viewerId = req.user?.id;
    const rawLimit = Number.parseInt(String(req.query.limit ?? ''), 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, DIRECTORY_MAX_LIMIT)
      : DIRECTORY_PAGE_SIZE;

    // Shared by both modes, and the only thing that is: the caller's own
    // exclusion set, which is about WHICH channels are eligible rather than about
    // how the answer is ordered or paged.
    //
    // The `ObjectId.isValid` filter that used to sit in the middle of this is
    // gone: it silently DROPPED every uuid v7 channel from the exclusion set, so
    // a channel the reader follows came back in the directory anyway. That is
    // the harmless direction (this parameter is a convenience, not a permission
    // — see {@link MAX_CALLER_CHANNEL_ROWS}), which is exactly why nobody would
    // have reported it.
    let excludedIds: string[] = [];
    if (viewerId && req.query.excludeFollowed === 'true') {
      const followed = await getDb()
        .select({ channelId: channelFollows.channelId })
        .from(channelFollows)
        .where(eq(channelFollows.oxyUserId, viewerId))
        .limit(MAX_CALLER_CHANNEL_ROWS);
      excludedIds = followed.map((row) => row.channelId);
    }

    // SEARCH mode returns from here, before the keyset cursor is so much as
    // parsed. That is the point: the two modes share no paging state at all, so
    // there is no arrangement of parameters in which a follower-count cursor can
    // be applied to a relevance-ordered page.
    const search = queryString(req.query.search)?.trim() ?? '';
    if (search) {
      const offset = Math.min(
        Math.max(queryInt(req.query.offset) ?? 0, 0),
        MAX_CHANNEL_SEARCH_OFFSET,
      );
      const found = await searchChannels(search, { limit, offset, excludeChannelIds: excludedIds });
      return sendSuccessResponse(res, 200, {
        items: found.items,
        hasMore: found.hasMore,
        ...(found.hasMore ? { nextOffset: offset + found.items.length } : {}),
      });
    }

    const conditions: SQL[] = [eq(channels.visibility, 'public')];
    if (excludedIds.length > 0) {
      conditions.push(notInArray(channels.id, excludedIds));
    }

    // `<followerCount>_<id>`: the two-part keyset the sort needs. A malformed
    // cursor is ignored rather than rejected — it can only cost the caller a
    // first page, and a 400 here breaks a client that stored an old format.
    //
    // The id half is NOT shape-checked. `ObjectId.isValid` stood there and would
    // have discarded every cursor this instance emits after the cutover, which
    // does not degrade to "an odd page" — it makes page two repeat page one
    // forever, so the client either loops or renders duplicates. A nonsense id
    // costs a first page and nothing more, which is what the rest of this
    // paragraph already promises.
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : '';
    const separator = cursor.lastIndexOf('_');
    if (separator > 0) {
      const count = Number.parseInt(cursor.slice(0, separator), 10);
      const lastId = cursor.slice(separator + 1);
      if (Number.isFinite(count) && lastId.length > 0) {
        // A disjunction is what a two-part keyset IS, and it lives inside this
        // query's own `and(...)` — the rule that forbids one applies to the feed
        // match objects `ChronoCursor.applyToQuery` ASSIGNS into, and is stated
        // here so nobody "fixes" this by copying it out of a feed source.
        conditions.push(
          or(
            lt(channels.followerCount, count),
            and(eq(channels.followerCount, count), lt(channels.id, lastId)),
          ) as SQL,
        );
      }
    }

    // `id` breaks the follower-count tie, and it is TEXT: it orders 24-hex
    // ObjectIds and uuid v7s in one collation, so the sequence is total and
    // stable but says nothing about age. Nothing here reads it as a time — it
    // exists so two channels on the same follower count cannot swap places
    // between two pages.
    const overfetched = await getDb()
      .select()
      .from(channels)
      .where(and(...conditions))
      .orderBy(desc(channels.followerCount), desc(channels.id))
      .limit(limit + 1);

    const hasMore = overfetched.length > limit;
    const page = hasMore ? overfetched.slice(0, limit) : overfetched;
    const last = page[page.length - 1];

    return sendSuccessResponse(res, 200, {
      items: page.map((channel) => serializeChannel(channel)),
      hasMore,
      ...(hasMore && last ? { nextCursor: `${last.followerCount}_${last.id}` } : {}),
    });
  } catch (err) {
    logger.error('[Channels] Error listing channels:', { error: err });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to list channels');
  }
});

/**
 * Whether a path segment could name a channel at all — an ObjectId, or a legal
 * handle.
 *
 * **This is what keeps the two routers out of each other's way.** The public
 * router is mounted BEFORE the authenticated one, so its `/:idOrHandle` route
 * sees `/channels/mine` and `/channels/invites` first, and a 404 from here would
 * mean those endpoints could never be reached. Both words are in
 * `RESERVED_CHANNEL_HANDLES`, so `normalizeChannelHandle` rejects them and this
 * answers `false` — the param routes then hand the request on rather than
 * claiming a segment they cannot interpret.
 *
 * That is also the right rule on its own terms, independently of the collision:
 * a route should only answer for what it can read.
 *
 * The id half is {@link isLiveEntityId} — one of the very few places
 * `MIGRATION-CONTRACT.md` sanctions it, and the reason is that this is not a
 * precondition on a QUERY. It decides which ROUTER answers, and it must accept
 * both live id shapes: `ObjectId.isValid` stood here and rejects every uuid v7,
 * while `normalizeChannelHandle` rejects one too (a handle carries no dashes) —
 * so after the cutover this function answered `false` for a real channel's own
 * id, `next()` found no other route, and the channel page 404ed. That could not
 * fire before this port, because every channel id in the database was still a
 * Mongo ObjectId.
 */
function couldNameAChannel(segment: string): boolean {
  return isLiveEntityId(segment) || normalizeChannelHandle(segment) !== null;
}

/**
 * GET /channels/:idOrHandle — one channel's page header.
 *
 * Resolves either spelling (see {@link findChannelByIdOrHandle}). The posts come
 * from the feed engine's `channel|<id>` descriptor, not from here.
 *
 * NOTE on the limiter: this route also fields `/mine`, `/invites` and
 * `/following` before handing them on (they are reserved handles, so
 * `couldNameAChannel` declines them and calls `next()`). The limiter runs BEFORE
 * that hand-off, so those three requests increment the read counter twice — once
 * here and once on the authenticated route that answers them — leaving them an
 * effective 150/min out of 300. That is deliberate: they are management screens
 * that spend one request per visit, and the alternative is either leaving a
 * genuinely anonymous route unlimited or moving the reserved-segment check into
 * middleware to save a counter increment nobody will reach.
 */
publicChannelsRouter.get('/:idOrHandle', ...readLimiters, async (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!couldNameAChannel(String(req.params.idOrHandle))) return next();
  try {
    const channel = await findChannelByIdOrHandle(String(req.params.idOrHandle));
    if (!channel || !canViewChannel(channel, req.user?.id)) {
      return sendErrorResponse(res, 404, 'Not Found', 'Channel not found');
    }
    const viewerState = await loadViewerState(channel.id, req.user?.id);
    return sendSuccessResponse(res, 200, serializeChannel(channel, viewerState));
  } catch (err) {
    logger.error('[Channels] Error loading channel:', { error: err });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to load channel');
  }
});

/**
 * GET /channels/:idOrHandle/members — who publishes here.
 *
 * ACCEPTED members only for a stranger; the OWNER additionally sees pending and
 * declined invitations, which are theirs to chase. A `removed` row is nobody's
 * business and is never listed — it exists to keep the unique index meaningful,
 * not to be read.
 *
 * Members are resolved through {@link resolveUserSummaries}, the same identity
 * path every post author goes through, never assembled by hand.
 */
publicChannelsRouter.get('/:idOrHandle/members', ...readLimiters, async (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!couldNameAChannel(String(req.params.idOrHandle))) return next();
  try {
    const channel = await findChannelByIdOrHandle(String(req.params.idOrHandle));
    if (!channel || !canViewChannel(channel, req.user?.id)) {
      return sendErrorResponse(res, 404, 'Not Found', 'Channel not found');
    }

    const isOwner = canManageChannel(channel, req.user?.id);
    const statuses: ChannelMemberSummary['status'][] = isOwner
      ? ['accepted', 'pending', 'declined']
      : ['accepted'];

    const members = await getDb()
      .select({
        oxyUserId: channelMembers.oxyUserId,
        role: channelMembers.role,
        status: channelMembers.status,
        invitedAt: channelMembers.invitedAt,
        respondedAt: channelMembers.respondedAt,
      })
      .from(channelMembers)
      .where(
        and(
          eq(channelMembers.channelId, channel.id),
          inArray(channelMembers.status, statuses),
        ),
      )
      .orderBy(asc(channelMembers.createdAt))
      .limit(MEMBER_PAGE_SIZE);

    if (members.length === 0) {
      return sendSuccessResponse(res, 200, []);
    }

    const summaries = await resolveUserSummaries(members.map((member) => member.oxyUserId));
    const items: ChannelMemberSummary[] = [];
    for (const member of members) {
      const user: PostUser | undefined = summaries.get(member.oxyUserId)?.user;
      if (!user) continue;
      items.push({
        user,
        role: member.role,
        status: member.status,
        ...(member.invitedAt ? { invitedAt: member.invitedAt.toISOString() } : {}),
        ...(member.respondedAt ? { respondedAt: member.respondedAt.toISOString() } : {}),
      });
    }

    return sendSuccessResponse(res, 200, items);
  } catch (err) {
    logger.error('[Channels] Error listing channel members:', { error: err });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to list members');
  }
});

/* ------------------------------------------------------------------------- */
/* Authenticated                                                              */
/* ------------------------------------------------------------------------- */

const router = Router();

// Defensive — the parent router already enforces it.
router.use(requireAuth);

/**
 * The channels one caller's membership rows point at, newest channel first.
 *
 * `GET /channels/mine` and `GET /channels/invites` ask the same question of two
 * membership statuses, so they share this rather than each spelling the join.
 *
 * The `ObjectId.isValid` filter that used to stand between the two queries is
 * gone, and this one mattered: it dropped every uuid v7 channel id, so after the
 * cutover BOTH endpoints answered with an empty list — a caller could not see
 * the channels they publish to or the invitations waiting for them, with no
 * error anywhere.
 */
async function channelsOfMembership(
  userId: string,
  status: ChannelMemberSummary['status'],
): Promise<ChannelRow[]> {
  const db = getDb();
  const memberships = await db
    .select({ channelId: channelMembers.channelId })
    .from(channelMembers)
    .where(and(eq(channelMembers.oxyUserId, userId), eq(channelMembers.status, status)))
    .limit(MAX_CALLER_CHANNEL_ROWS);
  const channelIds = memberships.map((row) => row.channelId);
  if (channelIds.length === 0) return [];
  return db
    .select()
    .from(channels)
    .where(inArray(channels.id, channelIds))
    .orderBy(desc(channels.createdAt))
    .limit(MAX_CALLER_CHANNEL_ROWS);
}

/** GET /channels/mine — the channels the caller may publish to, owned or not. */
router.get('/mine', ...readLimiters, async (req: AuthRequest, res: Response) => {
  try {
    const mine = await channelsOfMembership(getAuthenticatedUserId(req), 'accepted');
    return sendSuccessResponse(res, 200, mine.map((channel) => serializeChannel(channel)));
  } catch (err) {
    logger.error('[Channels] Error listing own channels:', { userId: req.user?.id, error: err });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to list channels');
  }
});

/** GET /channels/invites — membership invitations awaiting the caller's answer. */
router.get('/invites', ...readLimiters, async (req: AuthRequest, res: Response) => {
  try {
    const invites = await channelsOfMembership(getAuthenticatedUserId(req), 'pending');
    return sendSuccessResponse(res, 200, invites.map((channel) => serializeChannel(channel)));
  } catch (err) {
    logger.error('[Channels] Error listing channel invites:', { userId: req.user?.id, error: err });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to list invites');
  }
});

/**
 * GET /channels/following?cursor=<createdAtMs>_<followId>&limit=
 *
 * The channels this reader SUBSCRIBES to — the other half of the loop from
 * `POST /:id/follow`, and the list the whole feature promises: what you follow
 * without following anybody.
 *
 * Distinct from `GET /channels/mine`, which answers a different question with a
 * different model — that one is publishing RIGHTS (`ChannelMember`), this one is
 * readership (`ChannelFollow`). A reader typically has many of these and none of
 * those.
 *
 * **Keyset-paged, on the follow rows.** `{ createdAt: -1, _id: -1 }` within one
 * `oxyUserId` is exactly what `channel_follow_by_user_v1` stores. A skip/limit
 * page would duplicate and drop rows as the reader follows and unfollows
 * underneath their own list.
 *
 * Each row carries the caller's `viewerState` so the client can paint the mute
 * switch without a second request per channel: `notify` comes free off the follow
 * row being paged, and membership is resolved for the WHOLE page in one batched
 * query rather than per row — a partial `viewerState` would be worse than none,
 * because an absent `role` is documented to mean "not a member".
 */
router.get('/following', ...readLimiters, async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const rawLimit = Number.parseInt(String(req.query.limit ?? ''), 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, DIRECTORY_MAX_LIMIT)
      : DIRECTORY_PAGE_SIZE;

    const conditions: SQL[] = [eq(channelFollows.oxyUserId, userId)];

    // `<createdAtMs>_<followId>` — the same two-part shape the directory's cursor
    // uses, over this list's own axis. A malformed cursor is ignored rather than
    // rejected: it can only cost the caller a first page, and a 400 would break a
    // client holding an older format.
    //
    // Milliseconds are the whole precision the column holds: `created_at`
    // defaults to `date_trunc('milliseconds', now())` exactly so a value
    // survives the round trip through a JavaScript `Date` — see
    // `schema/columns.ts`. Without that, a cursor built from a read would sit
    // BELOW the row it came from and the page would never advance.
    //
    // The id half is not shape-checked, for the reason spelled out on the
    // directory's cursor above.
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : '';
    const separator = cursor.lastIndexOf('_');
    if (separator > 0) {
      const followedAtMs = Number.parseInt(cursor.slice(0, separator), 10);
      const lastId = cursor.slice(separator + 1);
      if (Number.isFinite(followedAtMs) && lastId.length > 0) {
        const followedAt = new Date(followedAtMs);
        conditions.push(
          or(
            lt(channelFollows.createdAt, followedAt),
            and(eq(channelFollows.createdAt, followedAt), lt(channelFollows.id, lastId)),
          ) as SQL,
        );
      }
    }

    const overfetched = await getDb()
      .select({
        id: channelFollows.id,
        channelId: channelFollows.channelId,
        notify: channelFollows.notify,
        createdAt: channelFollows.createdAt,
      })
      .from(channelFollows)
      .where(and(...conditions))
      .orderBy(desc(channelFollows.createdAt), desc(channelFollows.id))
      .limit(limit + 1);

    // `hasMore` and the cursor are BOTH taken from the FOLLOW rows, before any
    // channel is resolved. They describe how far this request consumed the
    // reader's subscription list, and a follow whose channel has since been
    // deleted must not be mistaken for reaching the end of it.
    const hasMore = overfetched.length > limit;
    const page = hasMore ? overfetched.slice(0, limit) : overfetched;
    const lastFollow = page[page.length - 1];

    const nextCursor = hasMore && lastFollow
      ? `${lastFollow.createdAt.getTime()}_${lastFollow.id}`
      : undefined;

    if (page.length === 0) {
      return sendSuccessResponse(res, 200, { items: [], hasMore, ...(nextCursor ? { nextCursor } : {}) });
    }

    const channelIds = page.map((row) => row.channelId);

    const db = getDb();
    const [followed, memberships] = await Promise.all([
      db.select().from(channels).where(inArray(channels.id, channelIds)),
      db
        .select({
          channelId: channelMembers.channelId,
          role: channelMembers.role,
          status: channelMembers.status,
        })
        .from(channelMembers)
        .where(
          and(
            inArray(channelMembers.channelId, channelIds),
            eq(channelMembers.oxyUserId, userId),
          ),
        ),
    ]);

    const channelById = new Map(followed.map((channel) => [channel.id, channel]));
    const membershipByChannel = new Map(memberships.map((row) => [row.channelId, row]));

    const items: ChannelDTO[] = [];
    for (const follow of page) {
      const channel = channelById.get(follow.channelId);
      // A follow whose channel is GONE. `channel_follows.channel_id` is
      // `ON DELETE CASCADE`, so an orphan cannot persist — but this page reads
      // the follows and the channels in two statements, and a channel deleted
      // between them lands exactly here. Drop the row rather than render a blank
      // card or fail the page; the cursor above already advanced past it, so the
      // next page is unaffected.
      if (!channel) continue;
      const membership = membershipByChannel.get(follow.channelId);
      items.push(
        serializeChannel(channel, {
          isFollowing: true,
          notify: follow.notify,
          ...(membership ? { role: membership.role, memberStatus: membership.status } : {}),
        }),
      );
    }

    return sendSuccessResponse(res, 200, {
      items,
      hasMore,
      ...(nextCursor ? { nextCursor } : {}),
    });
  } catch (err) {
    logger.error('[Channels] Error listing followed channels:', {
      userId: req.user?.id,
      error: err,
    });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to list followed channels');
  }
});

/**
 * POST /channels
 *
 * The 409 comes from the UNIQUE `channels_handle_lower_key`, not from a
 * pre-check: a `select` is not a lock, so two concurrent creates of one handle
 * are stopped by the constraint or not at all. The owner's own membership row is
 * written in the SAME transaction, which is what makes "may publish" ONE
 * question with ONE answer — there is no "or the owner" branch anywhere for it
 * to drift from, and therefore no way to repair a channel that got one write and
 * not the other.
 */
router.post('/', ...writeLimiters, validateBody(createChannelSchema), async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const body = req.body as z.infer<typeof createChannelSchema>;

    const handle = normalizeChannelHandle(body.handle);
    if (!handle) {
      return sendErrorResponse(
        res,
        400,
        'Bad Request',
        `handle must be ${CHANNEL_HANDLE_MIN_LENGTH}-${CHANNEL_HANDLE_MAX_LENGTH} characters of a-z, 0-9 or _, and not reserved`,
      );
    }

    const [owned] = await getDb()
      .select({ total: sql<number>`count(*)::int` })
      .from(channels)
      .where(eq(channels.ownerOxyUserId, userId));
    if (owned.total >= MAX_CHANNELS_PER_OWNER) {
      return sendErrorResponse(
        res,
        400,
        'Bad Request',
        `You can own at most ${MAX_CHANNELS_PER_OWNER} channels`,
      );
    }

    let created: ChannelRow;
    try {
      created = await insertChannelWithOwner(handle, userId, {
        title: body.title,
        description: body.description,
        avatar: body.avatar,
        banner: body.banner,
        signPosts: body.signPosts === true,
      });
    } catch (createErr) {
      if (isUniqueViolation(createErr, CHANNEL_HANDLE_UNIQUE)) {
        return sendErrorResponse(res, 409, 'Conflict', 'That channel handle is taken');
      }
      throw createErr;
    }

    return sendSuccessResponse(
      res,
      201,
      serializeChannel(created, {
        isFollowing: false,
        notify: false,
        role: 'owner',
        memberStatus: 'accepted',
      }),
      'Channel created',
    );
  } catch (err) {
    logger.error('[Channels] Error creating channel:', { userId: req.user?.id, error: err });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to create channel');
  }
});

/**
 * PUT /channels/:id — the owner edits the channel's profile.
 *
 * A RENAME is allowed and is deliberately cheap: the feed descriptor is by id, so
 * a pinned home tab survives it. What does NOT survive is an external link and the
 * OG shell, which is the reason to rename rarely rather than the reason to make
 * the descriptor carry the handle.
 */
router.put(
  '/:id',
  ...writeLimiters,
  validateObjectId('id'),
  validateBody(updateChannelSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const body = req.body as z.infer<typeof updateChannelSchema>;

      const channelId = String(req.params.id);
      const [channel] = await getDb()
        .select({ ownerOxyUserId: channels.ownerOxyUserId })
        .from(channels)
        .where(eq(channels.id, channelId))
        .limit(1);
      if (!channel) {
        return sendErrorResponse(res, 404, 'Not Found', 'Channel not found');
      }
      if (!canManageChannel(channel, userId)) {
        return sendErrorResponse(res, 403, 'Forbidden', 'Only the owner can edit this channel');
      }

      // Validated here so an illegal handle is a 400 naming the rule rather than
      // the repository's `ChannelHandleError`, which is the backstop underneath
      // this and answers no HTTP status of its own.
      if (body.handle !== undefined && normalizeChannelHandle(body.handle) === null) {
        return sendErrorResponse(res, 400, 'Bad Request', 'handle is not a valid channel handle');
      }

      let updated: ChannelRow | null;
      try {
        // `handle_lower` follows from the repository's own derivation, so the
        // normalization has exactly one definition.
        updated = await updateChannelProfile(channelId, body);
      } catch (saveErr) {
        if (isUniqueViolation(saveErr, CHANNEL_HANDLE_UNIQUE)) {
          return sendErrorResponse(res, 409, 'Conflict', 'That channel handle is taken');
        }
        throw saveErr;
      }
      if (!updated) {
        // Deleted between the authorization read and the write.
        return sendErrorResponse(res, 404, 'Not Found', 'Channel not found');
      }

      return sendSuccessResponse(res, 200, serializeChannel(updated), 'Channel updated');
    } catch (err) {
      logger.error('[Channels] Error updating channel:', {
        userId: req.user?.id,
        id: req.params.id,
        error: err,
      });
      return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to update channel');
    }
  },
);

/**
 * DELETE /channels/:id
 *
 * The cascade itself is `deleteChannelCascade` — ONE transaction, so unlike the
 * Mongo version there is no partway state to fail into. Two things survive the
 * move and are worth knowing here:
 *
 *  - **Releasing the posts is not tidiness, it is what stops them being
 *    deleted.** `posts.channel_id` is `ON DELETE CASCADE`, so the release is
 *    load-bearing in a way its Mongo `$unset` never was. A released post
 *    reappears on its author's profile because the exclusion is
 *    `channel_id is null`, and it stops being anonymous because hydration reads
 *    the channel through that column.
 *  - **Members and followers go with the row**, by their own
 *    `ON DELETE CASCADE`, and so do the channel's lanes' mutes — so the four
 *    hand-sequenced deletes the Mongo handler carried are now two statements and
 *    a constraint.
 */
router.delete('/:id', ...writeLimiters, validateObjectId('id'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const channelId = String(req.params.id);

    const [channel] = await getDb()
      .select({ ownerOxyUserId: channels.ownerOxyUserId })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);
    if (!channel) {
      return sendErrorResponse(res, 404, 'Not Found', 'Channel not found');
    }
    if (!canManageChannel(channel, userId)) {
      return sendErrorResponse(res, 403, 'Forbidden', 'Only the owner can delete this channel');
    }

    await deleteChannelCascade(channelId);

    return sendSuccessResponse(res, 200, { success: true }, 'Channel deleted');
  } catch (err) {
    logger.error('[Channels] Error deleting channel:', {
      userId: req.user?.id,
      id: req.params.id,
      error: err,
    });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to delete channel');
  }
});

/**
 * POST /channels/:id/members — the owner invites somebody to publish.
 *
 * The invite is `pending` and NOTIFIES: an invitation the invitee never sees is a
 * broken feature, which is why `channel_invite` is the one channel notification
 * that earns a type of its own.
 */
router.post(
  '/:id/members',
  ...writeLimiters,
  validateObjectId('id'),
  validateBody(inviteMemberSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const channelId = String(req.params.id);
      const { oxyUserId } = req.body as z.infer<typeof inviteMemberSchema>;

      const db = getDb();
      const [channel] = await db
        .select({ ownerOxyUserId: channels.ownerOxyUserId })
        .from(channels)
        .where(eq(channels.id, channelId))
        .limit(1);
      if (!channel) {
        return sendErrorResponse(res, 404, 'Not Found', 'Channel not found');
      }
      if (!canManageChannel(channel, userId)) {
        return sendErrorResponse(res, 403, 'Forbidden', 'Only the owner can invite members');
      }
      if (oxyUserId === userId) {
        return sendErrorResponse(res, 400, 'Bad Request', 'You are already a member');
      }

      const [members] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(channelMembers)
        .where(
          and(
            eq(channelMembers.channelId, channelId),
            inArray(channelMembers.status, ['accepted', 'pending']),
          ),
        );
      if (members.total >= MAX_CHANNEL_MEMBERS) {
        return sendErrorResponse(
          res,
          400,
          'Bad Request',
          `A channel can have at most ${MAX_CHANNEL_MEMBERS} members`,
        );
      }

      // A previously declined or removed member is re-invited by resetting the
      // row they already have, so this is ONE upsert rather than a read followed
      // by a branch: the `(channel_id, oxy_user_id)` unique constraint means
      // there is only ever one row, and `targetWhere` restricts the update half
      // to the two statuses a re-invite may overwrite. A row that is already
      // `accepted` or `pending` therefore matches no update, `returning` is
      // empty, and that empty result IS the 409 — decided by the constraint
      // rather than by a pre-check that is not a lock.
      const [invited] = await db
        .insert(channelMembers)
        .values({
          channelId,
          oxyUserId,
          role: 'publisher',
          status: 'pending',
          invitedByOxyUserId: userId,
          invitedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [channelMembers.channelId, channelMembers.oxyUserId],
          setWhere: inArray(channelMembers.status, ['declined', 'removed']),
          set: {
            role: 'publisher',
            status: 'pending',
            invitedByOxyUserId: userId,
            invitedAt: new Date(),
            respondedAt: null,
            updatedAt: new Date(),
          },
        })
        .returning({ id: channelMembers.id });
      if (!invited) {
        return sendErrorResponse(res, 409, 'Conflict', 'That user is already invited');
      }

      await createNotification({
        recipientId: oxyUserId,
        actorId: userId,
        type: 'channel_invite',
        entityId: channelId,
        entityType: 'channel',
      });

      return sendSuccessResponse(res, 201, { success: true }, 'Invitation sent');
    } catch (err) {
      logger.error('[Channels] Error inviting channel member:', {
        userId: req.user?.id,
        id: req.params.id,
        error: err,
      });
      return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to invite member');
    }
  },
);

/** POST /channels/:id/members/accept — the invitee accepts and may now publish. */
router.post('/:id/members/accept', ...writeLimiters, validateObjectId('id'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const channelId = String(req.params.id);

    // Filtered on `status = 'pending'` so this is a CLAIM, not a read-then-write:
    // a second accept matches nothing and the counter is bumped exactly once.
    const [accepted] = await getDb()
      .update(channelMembers)
      .set({ status: 'accepted', respondedAt: new Date() })
      .where(
        and(
          eq(channelMembers.channelId, channelId),
          eq(channelMembers.oxyUserId, userId),
          eq(channelMembers.status, 'pending'),
        ),
      )
      .returning({ id: channelMembers.id });
    if (!accepted) {
      return sendErrorResponse(res, 404, 'Not Found', 'No pending invitation');
    }

    await bumpChannelCounter(channelId, 'memberCount', 1);
    return sendSuccessResponse(res, 200, { success: true }, 'Invitation accepted');
  } catch (err) {
    logger.error('[Channels] Error accepting channel invite:', {
      userId: req.user?.id,
      id: req.params.id,
      error: err,
    });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to accept invitation');
  }
});

/** POST /channels/:id/members/decline — the invitee declines. */
router.post('/:id/members/decline', ...writeLimiters, validateObjectId('id'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const [declined] = await getDb()
      .update(channelMembers)
      .set({ status: 'declined', respondedAt: new Date() })
      .where(
        and(
          eq(channelMembers.channelId, String(req.params.id)),
          eq(channelMembers.oxyUserId, userId),
          eq(channelMembers.status, 'pending'),
        ),
      )
      .returning({ id: channelMembers.id });
    if (!declined) {
      return sendErrorResponse(res, 404, 'Not Found', 'No pending invitation');
    }
    return sendSuccessResponse(res, 200, { success: true }, 'Invitation declined');
  } catch (err) {
    logger.error('[Channels] Error declining channel invite:', {
      userId: req.user?.id,
      id: req.params.id,
      error: err,
    });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to decline invitation');
  }
});

/**
 * DELETE /channels/:id/members/:memberId — the owner removes a publisher, or a
 * publisher removes themselves.
 *
 * The OWNER's own row can never be removed: it is what `canPublishToChannel`
 * answers from, so removing it would leave a channel nobody can publish to, its
 * owner included. Deleting the channel is the operation that ends it.
 *
 * The row is marked `removed`, not deleted, so the unique `{channelId, oxyUserId}`
 * index keeps meaning what it says and a later re-invite reuses it.
 */
router.delete(
  '/:id/members/:memberId',
  ...writeLimiters,
  validateObjectId('id'),
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const channelId = String(req.params.id);
      const memberId = String(req.params.memberId);

      const db = getDb();
      const [channel] = await db
        .select({ ownerOxyUserId: channels.ownerOxyUserId })
        .from(channels)
        .where(eq(channels.id, channelId))
        .limit(1);
      if (!channel) {
        return sendErrorResponse(res, 404, 'Not Found', 'Channel not found');
      }
      if (!canManageChannel(channel, userId) && memberId !== userId) {
        return sendErrorResponse(res, 403, 'Forbidden', 'You cannot remove that member');
      }
      if (memberId === channel.ownerOxyUserId) {
        return sendErrorResponse(res, 400, 'Bad Request', 'The owner cannot be removed');
      }

      /**
       * Claim the row BY the status it is leaving, one status at a time, and let
       * which claim succeeded stand for the pre-image.
       *
       * Mongo read the pre-image out of `findOneAndUpdate({ new: false })`;
       * `UPDATE … RETURNING` hands back the NEW row, so a single claim over both
       * statuses would report `removed` either way and the previous state would
       * be unrecoverable. That matters because only an ACCEPTED member was ever
       * counted (`accept` is the only path that increments) — decrementing for a
       * cancelled PENDING invitation subtracts a count it never contributed, and
       * a channel that cancels a few invites walks its `member_count` toward the
       * `channels_counts_check` floor.
       *
       * Two statements, still exactly one claim: a row holds one status, so at
       * most one of these can match it, and a concurrent remove that wins takes
       * the row out of both filters and leaves this one with the 404.
       */
      const claim = (status: 'accepted' | 'pending') =>
        db
          .update(channelMembers)
          .set({ status: 'removed', respondedAt: new Date() })
          .where(
            and(
              eq(channelMembers.channelId, channelId),
              eq(channelMembers.oxyUserId, memberId),
              eq(channelMembers.status, status),
            ),
          )
          .returning({ id: channelMembers.id });

      const [removedAccepted] = await claim('accepted');
      if (removedAccepted) {
        await bumpChannelCounter(channelId, 'memberCount', -1);
        return sendSuccessResponse(res, 200, { success: true }, 'Member removed');
      }

      const [removedPending] = await claim('pending');
      if (!removedPending) {
        return sendErrorResponse(res, 404, 'Not Found', 'Member not found');
      }

      return sendSuccessResponse(res, 200, { success: true }, 'Member removed');
    } catch (err) {
      logger.error('[Channels] Error removing channel member:', {
        userId: req.user?.id,
        id: req.params.id,
        error: err,
      });
      return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to remove member');
    }
  },
);

/**
 * POST /channels/:id/follow — subscribe. Idempotent: the unique
 * `{oxyUserId, channelId}` index is what makes a repeat a no-op, and only a row
 * that did not exist bumps the counter.
 */
router.post('/:id/follow', ...writeLimiters, validateObjectId('id'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const channelId = String(req.params.id);

    const db = getDb();
    const [channel] = await db
      .select({ visibility: channels.visibility })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);
    if (!channel || !canViewChannel(channel, userId)) {
      return sendErrorResponse(res, 404, 'Not Found', 'Channel not found');
    }

    // `doNothing` on the unique constraint, and the EMPTY `returning` is the
    // answer: a row that already existed produces no row here, so "already
    // following" is decided by the constraint rather than by a read that is not
    // a lock. That also keeps the counter honest — only an insert that actually
    // happened bumps it, so a concurrent duplicate cannot double-count.
    const [created] = await db
      .insert(channelFollows)
      .values({ oxyUserId: userId, channelId, notify: true })
      .onConflictDoNothing({ target: [channelFollows.oxyUserId, channelFollows.channelId] })
      .returning({ id: channelFollows.id });
    if (!created) {
      return sendSuccessResponse(res, 200, { success: true }, 'Already following');
    }

    await bumpChannelCounter(channelId, 'followerCount', 1);
    return sendSuccessResponse(res, 201, { success: true }, 'Channel followed');
  } catch (err) {
    logger.error('[Channels] Error following channel:', {
      userId: req.user?.id,
      id: req.params.id,
      error: err,
    });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to follow channel');
  }
});

/**
 * DELETE /channels/:id/follow — unsubscribe. Idempotent: a channel that was not
 * followed answers the same success, because "not following" is exactly the state
 * the caller asked for. Only a row that actually went away decrements.
 */
router.delete('/:id/follow', ...writeLimiters, validateObjectId('id'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const channelId = String(req.params.id);
    const deleted = await getDb()
      .delete(channelFollows)
      .where(and(eq(channelFollows.oxyUserId, userId), eq(channelFollows.channelId, channelId)))
      .returning({ id: channelFollows.id });
    if (deleted.length > 0) {
      await bumpChannelCounter(channelId, 'followerCount', -1);
    }
    return sendSuccessResponse(res, 200, { success: true }, 'Channel unfollowed');
  } catch (err) {
    logger.error('[Channels] Error unfollowing channel:', {
      userId: req.user?.id,
      id: req.params.id,
      error: err,
    });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to unfollow channel');
  }
});

/**
 * PATCH /channels/:id/follow — a follower's own notification switch.
 *
 * The one piece of per-follower state `EntityFollow` could not have carried, and
 * therefore the reason `ChannelFollow` exists at all: muting a channel without
 * unfollowing it.
 */
router.patch(
  '/:id/follow',
  ...writeLimiters,
  validateObjectId('id'),
  validateBody(followSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const { notify } = req.body as z.infer<typeof followSchema>;
      const [updated] = await getDb()
        .update(channelFollows)
        .set({ notify })
        .where(
          and(
            eq(channelFollows.oxyUserId, userId),
            eq(channelFollows.channelId, String(req.params.id)),
          ),
        )
        .returning({ notify: channelFollows.notify });
      if (!updated) {
        return sendErrorResponse(res, 404, 'Not Found', 'You do not follow this channel');
      }
      return sendSuccessResponse(res, 200, { notify: updated.notify }, 'Notification setting updated');
    } catch (err) {
      logger.error('[Channels] Error updating channel follow:', {
        userId: req.user?.id,
        id: req.params.id,
        error: err,
      });
      return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to update setting');
    }
  },
);

export default router;
