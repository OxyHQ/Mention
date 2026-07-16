import { Router, Response } from 'express';
import UserSettings, { type ProfileMedia } from '../models/UserSettings';
import UserBehavior from '../models/UserBehavior';
import Post from '../models/Post';
import Bookmark from '../models/Bookmark';
import Like from '../models/Like';
// Block and Restrict routes removed - frontend should use Oxy services directly
import { requireOxyAuth as requireAuth, type OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { buildSettingsResponseForViewer, ensureUserSettings } from '../utils/userSettings';
import { ensureProfileMediaPublic } from '../utils/oxyHelpers';
import { sendErrorResponse, sendSuccessResponse, validateRequired } from '../utils/apiHelpers';
import { getRequiredOxyUserId as getAuthenticatedUserId } from '@oxyhq/core/server';
import { type TrackSummary, type PodcastSummary } from '@syra.fm/sdk';
import { EXTERNAL_EMBED_SOURCES, type EmbedPlayerSource } from '@mention/shared-types';
import { syraClient } from '../utils/syraPodcast';
import { federateAsResolvedActor } from '../connectors/outboundFederation';
import { logger } from '../utils/logger';

const router = Router();

/**
 * The public Syra preview is a fixed 30-second clip. A profile song's start
 * offset is clamped so the whole window stays inside the track.
 */
const PROFILE_MEDIA_PREVIEW_WINDOW_SEC = 30;

/**
 * Profile Settings API
 * All routes require authentication
 */

// Apply auth middleware to all routes
router.use(requireAuth);

/**
 * GET /api/profile/settings/me
 * Get current user's settings
 */
router.get('/settings/me', async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = getAuthenticatedUserId(req);
    const doc = await ensureUserSettings(oxyUserId);
    return sendSuccessResponse(res, 200, doc);
  } catch (err) {
    logger.error('[ProfileSettings] Error fetching my settings:', { userId: req.user?.id, error: err });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to fetch settings');
  }
});

/**
 * GET /api/profile/settings/:userId
 * Get settings by oxy user id
 */
router.get('/settings/:userId', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.params.userId as string;
    const viewerUserId = getAuthenticatedUserId(req);

    const validationError = validateRequired(userId, 'userId');
    if (validationError) {
      return sendErrorResponse(res, 400, 'Bad Request', validationError);
    }

    const doc = userId === viewerUserId
      ? await ensureUserSettings(userId)
      : await UserSettings.findOne({ oxyUserId: userId }).lean().exec();
    return sendSuccessResponse(res, 200, buildSettingsResponseForViewer(doc, userId, viewerUserId));
  } catch (err) {
    logger.error('[ProfileSettings] Error fetching user settings:', { userId: req.user?.id, targetUserId: req.params.userId, error: err });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to fetch settings');
  }
});

/**
 * PUT /api/profile/settings
 * Update current user's settings
 */
router.put('/settings', async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = getAuthenticatedUserId(req);
    const { appearance, profileHeaderImage, privacy, profileCustomization, profileMedia, interests, feedSettings, notificationPreferences, externalEmbeds } = req.body || {};

    const update: Record<string, any> = {};
    const unset: Record<string, ''> = {};
    // The Oxy file id newly set as the profile banner (if any). Captured here so
    // we can promote it to public AFTER the settings persist — profile banners
    // are public-facing media that an anonymous <img> must be able to load.
    let newBannerFileId: string | undefined;
    // Whether this request changed the profile banner (set OR cleared). The banner
    // is a Mention-owned ActivityPub actor field (`image`), so a change must
    // rebroadcast the actor to remote followers (see below).
    let bannerChanged = false;

    // Dot-notation, same safe pattern as `profileCustomization`/`externalEmbeds` below:
    // each field is set at its own leaf path, so a partial `appearance` payload (e.g. the
    // color picker sending only `primaryColor`) only touches the fields present in the
    // request and leaves every other appearance field untouched.
    if (appearance) {
      if (appearance.themeMode && ['light', 'dark', 'system'].includes(appearance.themeMode)) {
        update['appearance.themeMode'] = appearance.themeMode;
      }
      if (typeof appearance.primaryColor === 'string' && appearance.primaryColor.trim()) {
        update['appearance.primaryColor'] = appearance.primaryColor.trim();
      } else if (appearance.primaryColor === null) {
        unset['appearance.primaryColor'] = '';
      }
      if (['default', 'more', 'muchMore', 'all'].includes(appearance.postTextExpand)) {
        update['appearance.postTextExpand'] = appearance.postTextExpand;
      }
      if (['openPost', 'expandInline'].includes(appearance.postReadMoreAction)) {
        update['appearance.postReadMoreAction'] = appearance.postReadMoreAction;
      }
      if (typeof appearance.collapseLongBio === 'boolean') {
        update['appearance.collapseLongBio'] = appearance.collapseLongBio;
      }
    }
    
    if (typeof profileHeaderImage === 'string') {
      const trimmedProfileHeaderImage = profileHeaderImage.trim();
      if (trimmedProfileHeaderImage) {
        update.profileHeaderImage = trimmedProfileHeaderImage;
        newBannerFileId = trimmedProfileHeaderImage;
      } else {
        unset.profileHeaderImage = '';
      }
      bannerChanged = true;
    } else if (profileHeaderImage === null) {
      unset.profileHeaderImage = '';
      bannerChanged = true;
    }
    
    if (profileCustomization) {
      if (typeof profileCustomization.coverPhotoEnabled === 'boolean') {
        update['profileCustomization.coverPhotoEnabled'] = profileCustomization.coverPhotoEnabled;
      }
      if (typeof profileCustomization.minimalistMode === 'boolean') {
        update['profileCustomization.minimalistMode'] = profileCustomization.minimalistMode;
      }
    }

    // Profile media: an Instagram-style pinned Syra song OR podcast show
    // (mutually exclusive — one field, one value, so setting either type
    // automatically replaces the other). The client sends only an untrusted
    // reference: `{ type:'song', syraTrackId, startSec }`, `{ type:'podcast',
    // syraPodcastId }`, or `null` to clear. We NEVER persist client-supplied
    // metadata: the canonical title/artist/artwork and preview/show URL are
    // resolved server-side from the Syra catalog via @syra.fm/sdk; a song is
    // additionally rejected unless it exposes a public preview.
    if (profileMedia === null) {
      unset['profileCustomization.profileMedia'] = '';
    } else if (profileMedia && typeof profileMedia === 'object' && !Array.isArray(profileMedia)) {
      if (profileMedia.type === 'song') {
        const syraTrackId = typeof profileMedia.syraTrackId === 'string' ? profileMedia.syraTrackId.trim() : '';
        if (!syraTrackId) {
          return sendErrorResponse(res, 400, 'Bad Request', 'profileMedia.syraTrackId is required');
        }

        const requestedStartSec = typeof profileMedia.startSec === 'number' && Number.isFinite(profileMedia.startSec)
          ? Math.max(0, Math.trunc(profileMedia.startSec))
          : 0;

        let track: TrackSummary;
        try {
          track = await syraClient.getTrack(syraTrackId);
        } catch (err) {
          logger.warn('[ProfileSettings] Failed to resolve Syra track for profile media:', { userId: oxyUserId, syraTrackId, error: err });
          return sendErrorResponse(res, 400, 'Bad Request', 'Unable to resolve the selected song');
        }

        if (track.previewAvailable !== true) {
          return sendErrorResponse(res, 400, 'Bad Request', 'The selected song does not have a public preview');
        }

        // Clamp the start offset to [0, max(0, duration - 30)] so the full 30s
        // preview window always stays inside the track.
        const maxStartSec = Math.max(0, Math.trunc(track.duration) - PROFILE_MEDIA_PREVIEW_WINDOW_SEC);
        const clampedStartSec = Math.min(requestedStartSec, maxStartSec);

        update['profileCustomization.profileMedia'] = {
          type: 'song',
          syraTrackId,
          title: track.title,
          artist: track.artistName,
          artworkUrl: syraClient.artworkUrl(track),
          previewUrl: syraClient.previewUrl(syraTrackId, clampedStartSec),
          startSec: clampedStartSec,
          durationSec: track.duration,
        } satisfies ProfileMedia;
      } else if (profileMedia.type === 'podcast') {
        const syraPodcastId = typeof profileMedia.syraPodcastId === 'string' ? profileMedia.syraPodcastId.trim() : '';
        if (!syraPodcastId) {
          return sendErrorResponse(res, 400, 'Bad Request', 'profileMedia.syraPodcastId is required');
        }

        let show: PodcastSummary;
        try {
          show = await syraClient.getPodcast(syraPodcastId);
        } catch (err) {
          logger.warn('[ProfileSettings] Failed to resolve Syra podcast for profile media:', { userId: oxyUserId, syraPodcastId, error: err });
          return sendErrorResponse(res, 400, 'Bad Request', 'Unable to resolve the selected podcast');
        }

        update['profileCustomization.profileMedia'] = {
          type: 'podcast',
          syraPodcastId,
          title: show.title,
          author: show.author,
          artworkUrl: syraClient.podcastArtworkUrl(show),
          showUrl: syraClient.podcastUrl(syraPodcastId),
        } satisfies ProfileMedia;
      } else {
        return sendErrorResponse(res, 400, 'Bad Request', 'profileMedia.type must be "song" or "podcast"');
      }
    }

    if (privacy) {
      const privacyFields = [
        'profileVisibility',
        'showContactInfo',
        'allowTags',
        'allowMentions',
        'showOnlineStatus',
        'hideLikeCounts',
        'hideShareCounts',
        'hideReplyCounts',
        'hideSaveCounts',
        'showSensitiveContent',
      ] as const;
      
      privacyFields.forEach(field => {
        if (typeof privacy[field] === 'boolean') {
          update[`privacy.${field}`] = privacy[field];
        }
      });
      
      if (privacy.profileVisibility && ['public', 'private', 'followers_only'].includes(privacy.profileVisibility)) {
        update['privacy.profileVisibility'] = privacy.profileVisibility;
      }
      if (Array.isArray(privacy.hiddenWords)) {
        update['privacy.hiddenWords'] = privacy.hiddenWords;
      }
      if (Array.isArray(privacy.restrictedUsers)) {
        update['privacy.restrictedUsers'] = privacy.restrictedUsers;
      }
    }

    if (interests) {
      if (interests.tags === null || interests.tags === undefined) {
        // Allow clearing interests
        update['interests.tags'] = [];
      } else if (Array.isArray(interests.tags)) {
        // Validate that all tags are strings
        const validTags = interests.tags.filter((tag: unknown): tag is string => typeof tag === 'string');
        update['interests.tags'] = validTags;
      }
    }

    if (feedSettings) {
      // Validate and set diversity settings
      if (feedSettings.diversity) {
        if (typeof feedSettings.diversity.enabled === 'boolean') {
          update['feedSettings.diversity.enabled'] = feedSettings.diversity.enabled;
        }
        if (typeof feedSettings.diversity.sameAuthorPenalty === 'number') {
          const penalty = Math.max(0.5, Math.min(1.0, feedSettings.diversity.sameAuthorPenalty));
          update['feedSettings.diversity.sameAuthorPenalty'] = penalty;
        }
        if (typeof feedSettings.diversity.sameTopicPenalty === 'number') {
          const penalty = Math.max(0.5, Math.min(1.0, feedSettings.diversity.sameTopicPenalty));
          update['feedSettings.diversity.sameTopicPenalty'] = penalty;
        }
        if (typeof feedSettings.diversity.maxConsecutiveSameAuthor === 'number') {
          const maxConsecutive = Math.max(1, Math.min(10, Math.round(feedSettings.diversity.maxConsecutiveSameAuthor)));
          update['feedSettings.diversity.maxConsecutiveSameAuthor'] = maxConsecutive;
        } else if (feedSettings.diversity.maxConsecutiveSameAuthor === null) {
          update['feedSettings.diversity.maxConsecutiveSameAuthor'] = undefined;
        }
      }

      // Validate and set recency settings
      if (feedSettings.recency) {
        if (typeof feedSettings.recency.halfLifeHours === 'number') {
          const halfLife = Math.max(6, Math.min(72, feedSettings.recency.halfLifeHours));
          update['feedSettings.recency.halfLifeHours'] = halfLife;
        }
        if (typeof feedSettings.recency.maxAgeHours === 'number') {
          const maxAge = Math.max(24, Math.min(336, feedSettings.recency.maxAgeHours));
          update['feedSettings.recency.maxAgeHours'] = maxAge;
        }
      }

      // Validate and set quality settings
      if (feedSettings.quality) {
        if (typeof feedSettings.quality.boostHighQuality === 'boolean') {
          update['feedSettings.quality.boostHighQuality'] = feedSettings.quality.boostHighQuality;
        }
        if (typeof feedSettings.quality.minEngagementRate === 'number') {
          const minRate = Math.max(0, Math.min(1, feedSettings.quality.minEngagementRate));
          update['feedSettings.quality.minEngagementRate'] = minRate;
        } else if (feedSettings.quality.minEngagementRate === null) {
          update['feedSettings.quality.minEngagementRate'] = undefined;
        }
      }
    }

    if (notificationPreferences) {
      const boolFields = [
        'pushEnabled',
        'emailEnabled',
        'likes',
        'boosts',
        'follows',
        'mentions',
        'replies',
        'quotes',
      ] as const;

      boolFields.forEach(field => {
        if (typeof notificationPreferences[field] === 'boolean') {
          update[`notificationPreferences.${field}`] = notificationPreferences[field];
        }
      });
    }

    // Per-provider external-embed preferences (tri-state: 'show' | 'hide';
    // omitting/clearing a key falls back to "ask on first play"). Each key is
    // validated against the canonical EXTERNAL_EMBED_SOURCES whitelist so the
    // client can never write an arbitrary field: 'show'/'hide' set the dotted
    // path, null unsets it, anything else is ignored silently.
    if (externalEmbeds && typeof externalEmbeds === 'object' && !Array.isArray(externalEmbeds)) {
      const embeds = externalEmbeds as Record<string, unknown>;
      for (const key of Object.keys(embeds)) {
        if (!(EXTERNAL_EMBED_SOURCES as readonly string[]).includes(key)) continue;
        const source = key as EmbedPlayerSource;
        const value = embeds[source];
        if (value === 'show' || value === 'hide') {
          update[`externalEmbeds.${source}`] = value;
        } else if (value === null) {
          unset[`externalEmbeds.${source}`] = '';
        }
      }
    }

    const operation: Record<string, Record<string, any>> = {};
    if (Object.keys(update).length > 0) {
      operation.$set = update;
    }
    if (Object.keys(unset).length > 0) {
      operation.$unset = unset;
    }

    const doc = Object.keys(operation).length > 0
      ? await UserSettings.findOneAndUpdate(
        { oxyUserId },
        operation,
        { upsert: true, new: true }
      ).lean()
      : await ensureUserSettings(oxyUserId);

    // Profile banners are public-facing media: an anonymous <img> on a profile
    // page can't send a bearer token, so a private Oxy asset is denied and the
    // banner never renders. Promote the newly set banner asset to public using
    // the owner's own session token (Oxy's visibility route requires it). This
    // mirrors how Oxy auto-publishes avatars on PUT /users/me; the banner is a
    // Mention-only field, so Mention owns this promotion. Best-effort: it never
    // throws and never blocks the settings update.
    if (newBannerFileId) {
      await ensureProfileMediaPublic(req.accessToken, newBannerFileId);
    }

    // Outbound federation: the banner is a Mention-owned ActivityPub actor field
    // (`image`), so changing it (set or cleared) rebroadcasts the FULL actor
    // document as an Update(Person) to remote followers, prompting Mastodon to
    // refresh the cached profile. Fire-and-forget through the connector seam (which
    // applies the fediverseSharing gate); never blocks the settings response. NOTE:
    // Oxy-owned actor fields (displayName / avatar / bio) have NO Mention-side write
    // to hook here — propagating those needs a separate Oxy→Mention signal or a
    // periodic actor re-broadcast (documented follow-up).
    if (bannerChanged) {
      federateAsResolvedActor(oxyUserId, 'actor update', (username) => ({
        kind: 'actor.update',
        actorOxyUserId: oxyUserId,
        actorUsername: username,
      }));
    }

    return sendSuccessResponse(res, 200, doc);
  } catch (err) {
    logger.error('[ProfileSettings] Error updating settings:', { userId: req.user?.id, error: err });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to update settings');
  }
});

/**
 * DELETE /api/profile/settings/behavior
 * Reset user behavior/preferences
 */
router.delete('/settings/behavior', async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = getAuthenticatedUserId(req);
    const result = await UserBehavior.findOneAndDelete({ oxyUserId });

    return sendSuccessResponse(
      res,
      200,
      { success: true },
      result ? 'Personalization data reset successfully' : 'No personalization data to reset'
    );
  } catch (err) {
    logger.error('[ProfileSettings] Error resetting user behavior:', { userId: req.user?.id, error: err });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to reset personalization data');
  }
});

/**
 * POST /api/profile/export
 * Export the caller's data as newline-delimited JSON (NDJSON).
 *
 * The export is STREAMED from Mongo cursors, one document per line, so a power
 * user's entire history is never buffered into a single in-memory JSON blob —
 * the previous implementation loaded every post, bookmark, and like at once,
 * which spikes memory (and can OOM the task) for large accounts. Nothing is
 * truncated: every matching document is emitted.
 *
 * Line shape: `{"type":"meta"|"post"|"bookmark"|"like"|"settings","data":<doc>}`.
 * A single `meta` line comes first, then all posts, bookmarks, and likes, then
 * the settings document.
 */
router.post('/export', async (req: AuthRequest, res: Response) => {
  const oxyUserId = getAuthenticatedUserId(req);

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="mention-export-${oxyUserId}.ndjson"`);

  const writeLine = (type: string, data: unknown): void => {
    res.write(`${JSON.stringify({ type, data })}\n`);
  };

  try {
    writeLine('meta', { exportedAt: new Date().toISOString(), userId: oxyUserId });

    for await (const post of Post.find({ oxyUserId }).sort({ createdAt: -1 }).lean().cursor()) {
      writeLine('post', post);
    }
    for await (const bookmark of Bookmark.find({ userId: oxyUserId }).sort({ createdAt: -1 }).lean().cursor()) {
      writeLine('bookmark', bookmark);
    }
    for await (const like of Like.find({ userId: oxyUserId }).sort({ createdAt: -1 }).lean().cursor()) {
      writeLine('like', like);
    }

    const settings = await UserSettings.findOne({ oxyUserId }).lean();
    writeLine('settings', settings ?? null);

    res.end();
  } catch (err) {
    logger.error('[ProfileSettings] Error exporting user data:', { userId: req.user?.id, error: err });
    if (res.headersSent) {
      // The stream already started, so a JSON error body is no longer possible —
      // destroy the socket so the client sees a failed/incomplete download
      // rather than a silently truncated one it would treat as complete.
      res.destroy(err instanceof Error ? err : new Error('export failed'));
      return;
    }
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to export user data');
  }
});

export default router;
