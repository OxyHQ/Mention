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
 * EXPRESS ORDERING: `/mine` and `/invites` are declared BEFORE `/:id`, or `:id`
 * swallows them — the same dodge `routes/lanes.routes.ts` and `routes/posts.ts`
 * already make.
 *
 * SEPARATION OF POWERS, enforced through `services/channelAccess` and nowhere
 * else, so "may publish" cannot come to mean one thing here and another in the
 * post controller:
 *  - the OWNER manages the channel, its profile and its membership;
 *  - a PUBLISHER publishes to it and nothing more;
 *  - a FOLLOWER only reads, and owns one switch of their own (`notify`).
 */

import { Router, type NextFunction, type Response } from 'express';
import mongoose from 'mongoose';
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
import { Channel, type IChannel } from '../models/Channel';
import { ChannelMember } from '../models/ChannelMember';
import { ChannelFollow } from '../models/ChannelFollow';
import { Lane } from '../models/Lane';
import { LaneMute } from '../models/LaneMute';
import { Post } from '../models/Post';
import { resolveUserSummaries } from '../services/PostHydrationService';
import {
  bumpChannelCounter,
  canManageChannel,
  canViewChannel,
} from '../services/channelAccess';
import { createNotification } from '../utils/notificationUtils';
import { validateBody, validateObjectId } from '../middleware/validate';
import { sendErrorResponse, sendSuccessResponse } from '../utils/apiHelpers';
import { logger } from '../utils/logger';

/** Directory page size, and the ceiling a caller's `limit` is clamped to. */
const DIRECTORY_PAGE_SIZE = 20;
const DIRECTORY_MAX_LIMIT = 50;

/** Member-list page size — bounded by {@link MAX_CHANNEL_MEMBERS} anyway. */
const MEMBER_PAGE_SIZE = MAX_CHANNEL_MEMBERS;

const handleSchema = z
  .string()
  .min(CHANNEL_HANDLE_MIN_LENGTH)
  .max(CHANNEL_HANDLE_MAX_LENGTH + 1)
  .transform((value) => value.trim());

const createChannelSchema = z.object({
  handle: handleSchema,
  title: z.string().min(1, 'title is required').max(MAX_CHANNEL_TITLE_LENGTH).transform((v) => v.trim()),
  description: z.string().max(MAX_CHANNEL_DESCRIPTION_LENGTH).optional(),
  avatar: z.string().optional(),
  banner: z.string().optional(),
  signPosts: z.boolean().optional(),
});

const updateChannelSchema = z.object({
  handle: handleSchema.optional(),
  title: z.string().min(1).max(MAX_CHANNEL_TITLE_LENGTH).transform((v) => v.trim()).optional(),
  description: z.string().max(MAX_CHANNEL_DESCRIPTION_LENGTH).optional(),
  avatar: z.string().optional(),
  banner: z.string().optional(),
  signPosts: z.boolean().optional(),
});

const inviteMemberSchema = z.object({
  oxyUserId: z.string().min(1, 'oxyUserId is required').transform((v) => v.trim()),
});

const followSchema = z.object({
  notify: z.boolean(),
});

/** Shape of a `Channel` document as the routes below read it back. */
interface ChannelLean {
  _id: unknown;
  handle: string;
  title: string;
  description?: string;
  avatar?: string;
  banner?: string;
  ownerOxyUserId: string;
  visibility: string;
  signPosts?: boolean;
  followerCount?: number;
  memberCount?: number;
  postCount?: number;
  createdAt: Date;
  updatedAt: Date;
}

function serialize(doc: ChannelLean, viewerState?: ChannelViewerState): ChannelDTO {
  return {
    id: String(doc._id),
    handle: doc.handle,
    title: doc.title,
    ...(doc.description ? { description: doc.description } : {}),
    ...(doc.avatar ? { avatar: doc.avatar } : {}),
    ...(doc.banner ? { banner: doc.banner } : {}),
    ownerOxyUserId: doc.ownerOxyUserId,
    // The stored value is the authority; the cast is safe because the schema enum
    // is the same list the DTO type is built from.
    visibility: 'public',
    signPosts: doc.signPosts === true,
    followerCount: doc.followerCount ?? 0,
    memberCount: doc.memberCount ?? 0,
    postCount: doc.postCount ?? 0,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    ...(viewerState ? { viewerState } : {}),
  };
}

/**
 * Resolve a channel by its `_id` OR its handle — the one place both spellings are
 * accepted, so a URL can carry the readable one while the feed descriptor keeps
 * the stable one.
 *
 * A 24-hex value is tried as an id FIRST and then, on a miss, as a handle: a
 * handle is `[a-z0-9_]{3,30}` and so a 24-character all-hex handle is legal, and
 * refusing to fall through would make that one handle permanently unreachable.
 */
async function findChannelByIdOrHandle(idOrHandle: string): Promise<ChannelLean | null> {
  if (mongoose.Types.ObjectId.isValid(idOrHandle)) {
    const byId = await Channel.findById(idOrHandle).lean<ChannelLean | null>();
    if (byId) return byId;
  }
  const canonical = normalizeChannelHandle(idOrHandle);
  if (!canonical) return null;
  return Channel.findOne({ handleLower: canonical }).lean<ChannelLean | null>();
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
  const [follow, member] = await Promise.all([
    ChannelFollow.findOne({ oxyUserId: viewerId, channelId })
      .select('notify')
      .lean<{ notify?: boolean } | null>(),
    ChannelMember.findOne({ channelId, oxyUserId: viewerId })
      .select('role status')
      .lean<{ role: ChannelMemberSummary['role']; status: ChannelMemberSummary['status'] } | null>(),
  ]);
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

/**
 * GET /channels?cursor=<followerCount>_<id>&limit=&excludeFollowed=true
 *
 * The directory, most-followed first. Keyset-paged on
 * `{ followerCount: -1, _id: -1 }`, which is exactly what
 * `{ visibility, followerCount, _id }` stores — the same shape
 * `GET /feeds/marketplace` uses, and for the same reason: a skip/limit directory
 * duplicates and drops rows as follower counts move underneath it.
 *
 * `excludeFollowed` needs a caller, so it is a no-op for an anonymous reader
 * rather than an error — the directory is the same list either way.
 */
publicChannelsRouter.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const viewerId = req.user?.id;
    const rawLimit = Number.parseInt(String(req.query.limit ?? ''), 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, DIRECTORY_MAX_LIMIT)
      : DIRECTORY_PAGE_SIZE;

    const match: Record<string, unknown> = { visibility: 'public' };

    // `<followerCount>_<id>`: the two-part keyset the sort needs. A malformed
    // cursor is ignored rather than rejected — it can only cost the caller a
    // first page, and a 400 here breaks a client that stored an old format.
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : '';
    const separator = cursor.lastIndexOf('_');
    if (separator > 0) {
      const count = Number.parseInt(cursor.slice(0, separator), 10);
      const lastId = cursor.slice(separator + 1);
      if (Number.isFinite(count) && mongoose.Types.ObjectId.isValid(lastId)) {
        // An `$or` is unavoidable for a two-part keyset, but this query has NO
        // `ChronoCursor` anywhere near it, so the clobber that rule exists for
        // cannot apply. It is stated here so nobody "fixes" it by copying the
        // no-`$or` rule out of a feed source, where the reason is real.
        match.$or = [
          { followerCount: { $lt: count } },
          { followerCount: count, _id: { $lt: new mongoose.Types.ObjectId(lastId) } },
        ];
      }
    }

    if (viewerId && req.query.excludeFollowed === 'true') {
      const followed = await ChannelFollow.find({ oxyUserId: viewerId })
        .select('channelId')
        .lean<Array<{ channelId: string }>>();
      const followedIds = followed
        .map((row) => row.channelId)
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));
      if (followedIds.length > 0) {
        match._id = { $nin: followedIds };
      }
    }

    const overfetched = await Channel.find(match)
      .sort({ followerCount: -1, _id: -1 })
      .limit(limit + 1)
      .lean<ChannelLean[]>();

    const hasMore = overfetched.length > limit;
    const page = hasMore ? overfetched.slice(0, limit) : overfetched;
    const last = page[page.length - 1];

    return sendSuccessResponse(res, 200, {
      items: page.map((channel) => serialize(channel)),
      hasMore,
      ...(hasMore && last
        ? { nextCursor: `${last.followerCount ?? 0}_${String(last._id)}` }
        : {}),
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
 */
function couldNameAChannel(segment: string): boolean {
  return mongoose.Types.ObjectId.isValid(segment) || normalizeChannelHandle(segment) !== null;
}

/**
 * GET /channels/:idOrHandle — one channel's page header.
 *
 * Resolves either spelling (see {@link findChannelByIdOrHandle}). The posts come
 * from the feed engine's `channel|<id>` descriptor, not from here.
 */
publicChannelsRouter.get('/:idOrHandle', async (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!couldNameAChannel(String(req.params.idOrHandle))) return next();
  try {
    const channel = await findChannelByIdOrHandle(String(req.params.idOrHandle));
    if (!channel || !canViewChannel(channel, req.user?.id)) {
      return sendErrorResponse(res, 404, 'Not Found', 'Channel not found');
    }
    const viewerState = await loadViewerState(String(channel._id), req.user?.id);
    return sendSuccessResponse(res, 200, serialize(channel, viewerState));
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
publicChannelsRouter.get('/:idOrHandle/members', async (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!couldNameAChannel(String(req.params.idOrHandle))) return next();
  try {
    const channel = await findChannelByIdOrHandle(String(req.params.idOrHandle));
    if (!channel || !canViewChannel(channel, req.user?.id)) {
      return sendErrorResponse(res, 404, 'Not Found', 'Channel not found');
    }

    const isOwner = canManageChannel(channel, req.user?.id);
    const statuses = isOwner ? ['accepted', 'pending', 'declined'] : ['accepted'];

    const members = await ChannelMember.find({
      channelId: String(channel._id),
      status: { $in: statuses },
    })
      .sort({ createdAt: 1 })
      .limit(MEMBER_PAGE_SIZE)
      .lean<Array<{
        oxyUserId: string;
        role: ChannelMemberSummary['role'];
        status: ChannelMemberSummary['status'];
        invitedAt?: Date;
        respondedAt?: Date;
      }>>();

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

/** GET /channels/mine — the channels the caller may publish to, owned or not. */
router.get('/mine', async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const memberships = await ChannelMember.find({ oxyUserId: userId, status: 'accepted' })
      .select('channelId')
      .lean<Array<{ channelId: string }>>();
    const channelIds = memberships
      .map((row) => row.channelId)
      .filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (channelIds.length === 0) {
      return sendSuccessResponse(res, 200, []);
    }
    const channels = await Channel.find({ _id: { $in: channelIds } })
      .sort({ createdAt: -1 })
      .lean<ChannelLean[]>();
    return sendSuccessResponse(res, 200, channels.map((channel) => serialize(channel)));
  } catch (err) {
    logger.error('[Channels] Error listing own channels:', { userId: req.user?.id, error: err });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to list channels');
  }
});

/** GET /channels/invites — membership invitations awaiting the caller's answer. */
router.get('/invites', async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const invites = await ChannelMember.find({ oxyUserId: userId, status: 'pending' })
      .select('channelId')
      .lean<Array<{ channelId: string }>>();
    const channelIds = invites
      .map((row) => row.channelId)
      .filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (channelIds.length === 0) {
      return sendSuccessResponse(res, 200, []);
    }
    const channels = await Channel.find({ _id: { $in: channelIds } })
      .sort({ createdAt: -1 })
      .lean<ChannelLean[]>();
    return sendSuccessResponse(res, 200, channels.map((channel) => serialize(channel)));
  } catch (err) {
    logger.error('[Channels] Error listing channel invites:', { userId: req.user?.id, error: err });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to list invites');
  }
});

/**
 * POST /channels
 *
 * The 409 comes from the UNIQUE `{handleLower}` index, not from the pre-check: a
 * `findOne` is not a lock, so two concurrent creates of one handle are stopped by
 * the constraint or not at all. The owner's own `ChannelMember` row is written
 * immediately after, which is what makes "may publish" ONE question with ONE
 * answer — there is no "or the owner" branch anywhere for it to drift from.
 */
router.post('/', validateBody(createChannelSchema), async (req: AuthRequest, res: Response) => {
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

    const owned = await Channel.countDocuments({ ownerOxyUserId: userId });
    if (owned >= MAX_CHANNELS_PER_OWNER) {
      return sendErrorResponse(
        res,
        400,
        'Bad Request',
        `You can own at most ${MAX_CHANNELS_PER_OWNER} channels`,
      );
    }

    let created: IChannel;
    try {
      created = await Channel.create({
        handle,
        title: body.title,
        description: body.description,
        avatar: body.avatar,
        banner: body.banner,
        ownerOxyUserId: userId,
        visibility: 'public',
        signPosts: body.signPosts === true,
        memberCount: 1,
      });
    } catch (createErr) {
      if ((createErr as { code?: number }).code === 11000) {
        return sendErrorResponse(res, 409, 'Conflict', 'That channel handle is taken');
      }
      throw createErr;
    }

    await ChannelMember.create({
      channelId: String(created._id),
      oxyUserId: userId,
      role: 'owner',
      status: 'accepted',
      respondedAt: new Date(),
    });

    return sendSuccessResponse(
      res,
      201,
      serialize(created.toObject() as ChannelLean, {
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
  validateObjectId('id'),
  validateBody(updateChannelSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const body = req.body as z.infer<typeof updateChannelSchema>;

      const channel = await Channel.findById(req.params.id);
      if (!channel) {
        return sendErrorResponse(res, 404, 'Not Found', 'Channel not found');
      }
      if (!canManageChannel(channel, userId)) {
        return sendErrorResponse(res, 403, 'Forbidden', 'Only the owner can edit this channel');
      }

      if (body.handle !== undefined) {
        const handle = normalizeChannelHandle(body.handle);
        if (!handle) {
          return sendErrorResponse(res, 400, 'Bad Request', 'handle is not a valid channel handle');
        }
        // `handleLower` follows from the model's own hook, so the normalization
        // has exactly one definition.
        channel.handle = handle;
      }
      if (body.title !== undefined) channel.title = body.title;
      if (body.description !== undefined) channel.description = body.description;
      if (body.avatar !== undefined) channel.avatar = body.avatar;
      if (body.banner !== undefined) channel.banner = body.banner;
      if (body.signPosts !== undefined) channel.signPosts = body.signPosts;

      try {
        await channel.save();
      } catch (saveErr) {
        if ((saveErr as { code?: number }).code === 11000) {
          return sendErrorResponse(res, 409, 'Conflict', 'That channel handle is taken');
        }
        throw saveErr;
      }

      return sendSuccessResponse(
        res,
        200,
        serialize(channel.toObject() as ChannelLean),
        'Channel updated',
      );
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
 * THE ORDER OF THE WRITES IS LOAD-BEARING, and the FIRST one is the whole reason
 * this handler is not a one-liner:
 *
 *  1. **`$unset` `channelId` on the channel's posts.** Skip it and those posts are
 *     reachable from NOTHING: still excluded from their author's profile and their
 *     followers' timeline (`EXCLUDE_CHANNEL_POSTS` matches on the field's
 *     presence, not on the channel existing), while the `channel|<id>` feed no
 *     longer resolves. They also become anonymous forever, because hydration
 *     treats a post whose channel is missing as unsigned.
 *  2. unset `laneId` on those same posts and delete the channel's lanes and their
 *     mutes — a lane whose publisher is gone can never be reached or managed.
 *  3. delete the membership and follow rows,
 *  4. delete the channel.
 *
 * An interruption partway through leaves posts that have already been released
 * back to their authors, which is the safe direction to fail in.
 */
router.delete('/:id', validateObjectId('id'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const channelId = String(req.params.id);

    const channel = await Channel.findById(channelId)
      .select('ownerOxyUserId')
      .lean<{ ownerOxyUserId: string } | null>();
    if (!channel) {
      return sendErrorResponse(res, 404, 'Not Found', 'Channel not found');
    }
    if (!canManageChannel(channel, userId)) {
      return sendErrorResponse(res, 403, 'Forbidden', 'Only the owner can delete this channel');
    }

    await Post.updateMany({ channelId }, { $unset: { channelId: '', laneId: '' } });

    const lanes = await Lane.find({ ownerType: 'channel', ownerId: channelId })
      .select('_id')
      .lean<Array<{ _id: unknown }>>();
    if (lanes.length > 0) {
      await LaneMute.deleteMany({ laneId: { $in: lanes.map((lane) => String(lane._id)) } });
      await Lane.deleteMany({ ownerType: 'channel', ownerId: channelId });
    }

    await ChannelMember.deleteMany({ channelId });
    await ChannelFollow.deleteMany({ channelId });
    await Channel.deleteOne({ _id: channelId });

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
  validateObjectId('id'),
  validateBody(inviteMemberSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const channelId = String(req.params.id);
      const { oxyUserId } = req.body as z.infer<typeof inviteMemberSchema>;

      const channel = await Channel.findById(channelId)
        .select('ownerOxyUserId')
        .lean<{ ownerOxyUserId: string } | null>();
      if (!channel) {
        return sendErrorResponse(res, 404, 'Not Found', 'Channel not found');
      }
      if (!canManageChannel(channel, userId)) {
        return sendErrorResponse(res, 403, 'Forbidden', 'Only the owner can invite members');
      }
      if (oxyUserId === userId) {
        return sendErrorResponse(res, 400, 'Bad Request', 'You are already a member');
      }

      const memberCount = await ChannelMember.countDocuments({
        channelId,
        status: { $in: ['accepted', 'pending'] },
      });
      if (memberCount >= MAX_CHANNEL_MEMBERS) {
        return sendErrorResponse(
          res,
          400,
          'Bad Request',
          `A channel can have at most ${MAX_CHANNEL_MEMBERS} members`,
        );
      }

      const existing = await ChannelMember.findOne({ channelId, oxyUserId });
      if (existing && (existing.status === 'accepted' || existing.status === 'pending')) {
        return sendErrorResponse(res, 409, 'Conflict', 'That user is already invited');
      }

      // A previously declined or removed member is re-invited by resetting the row
      // they already have — the unique index means there is only ever one.
      if (existing) {
        existing.status = 'pending';
        existing.role = 'publisher';
        existing.invitedByOxyUserId = userId;
        existing.invitedAt = new Date();
        existing.respondedAt = undefined;
        await existing.save();
      } else {
        try {
          await ChannelMember.create({
            channelId,
            oxyUserId,
            role: 'publisher',
            status: 'pending',
            invitedByOxyUserId: userId,
            invitedAt: new Date(),
          });
        } catch (createErr) {
          if ((createErr as { code?: number }).code === 11000) {
            return sendErrorResponse(res, 409, 'Conflict', 'That user is already invited');
          }
          throw createErr;
        }
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
router.post('/:id/members/accept', validateObjectId('id'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const channelId = String(req.params.id);

    // Filtered on `status: 'pending'` so this is a CLAIM, not a read-then-write: a
    // second accept matches nothing and the counter is bumped exactly once.
    const accepted = await ChannelMember.findOneAndUpdate(
      { channelId, oxyUserId: userId, status: 'pending' },
      { $set: { status: 'accepted', respondedAt: new Date() } },
      { new: true },
    );
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
router.post('/:id/members/decline', validateObjectId('id'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const declined = await ChannelMember.findOneAndUpdate(
      { channelId: String(req.params.id), oxyUserId: userId, status: 'pending' },
      { $set: { status: 'declined', respondedAt: new Date() } },
      { new: true },
    );
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
  validateObjectId('id'),
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const channelId = String(req.params.id);
      const memberId = String(req.params.memberId);

      const channel = await Channel.findById(channelId)
        .select('ownerOxyUserId')
        .lean<{ ownerOxyUserId: string } | null>();
      if (!channel) {
        return sendErrorResponse(res, 404, 'Not Found', 'Channel not found');
      }
      if (!canManageChannel(channel, userId) && memberId !== userId) {
        return sendErrorResponse(res, 403, 'Forbidden', 'You cannot remove that member');
      }
      if (memberId === channel.ownerOxyUserId) {
        return sendErrorResponse(res, 400, 'Bad Request', 'The owner cannot be removed');
      }

      const removed = await ChannelMember.findOneAndUpdate(
        { channelId, oxyUserId: memberId, status: { $in: ['accepted', 'pending'] } },
        { $set: { status: 'removed', respondedAt: new Date() } },
        { new: true, projection: { status: 1 } },
      ).lean<{ status: string } | null>();
      if (!removed) {
        return sendErrorResponse(res, 404, 'Not Found', 'Member not found');
      }

      // Only an ACCEPTED member was ever counted, so only that transition
      // decrements. The claim above is what makes this exactly once.
      await bumpChannelCounter(channelId, 'memberCount', -1);

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
router.post('/:id/follow', validateObjectId('id'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const channelId = String(req.params.id);

    const channel = await Channel.findById(channelId)
      .select('visibility')
      .lean<{ visibility: string } | null>();
    if (!channel || !canViewChannel(channel, userId)) {
      return sendErrorResponse(res, 404, 'Not Found', 'Channel not found');
    }

    const existing = await ChannelFollow.findOne({ oxyUserId: userId, channelId })
      .select('_id')
      .lean<{ _id: unknown } | null>();
    if (existing) {
      return sendSuccessResponse(res, 200, { success: true }, 'Already following');
    }

    try {
      await ChannelFollow.create({ oxyUserId: userId, channelId, notify: true });
    } catch (createErr) {
      // The unique index — a concurrent request won the race, which is the same
      // outcome the caller asked for, and it already bumped the counter.
      if ((createErr as { code?: number }).code === 11000) {
        return sendSuccessResponse(res, 200, { success: true }, 'Already following');
      }
      throw createErr;
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
router.delete('/:id/follow', validateObjectId('id'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const channelId = String(req.params.id);
    const result = await ChannelFollow.deleteOne({ oxyUserId: userId, channelId });
    if (result.deletedCount > 0) {
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
  validateObjectId('id'),
  validateBody(followSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const { notify } = req.body as z.infer<typeof followSchema>;
      const updated = await ChannelFollow.findOneAndUpdate(
        { oxyUserId: userId, channelId: String(req.params.id) },
        { $set: { notify } },
        { new: true, projection: { notify: 1 } },
      ).lean<{ notify: boolean } | null>();
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
