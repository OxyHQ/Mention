import { Router, Response } from 'express';
import multer from 'multer';
import Room, { IRoom, PodcastQueueItem, RoomStatus, RoomType, OwnerType, BroadcastKind, SpeakerPermission } from '../models/Room';
import House, { HouseMemberRole } from '../models/House';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { isAdmin } from '../middleware/admin';
import { logger } from '../utils/logger';
import {
  generateRoomToken,
  generateBroadcastToken,
  createLiveKitRoomForRoom,
  ensureLiveKitRoomForRoom,
  deleteLiveKitRoomForRoom,
  createRoomUrlIngress,
  createRoomRtmpIngress,
  deleteIngress,
  startRoomRecording,
  stopRoomRecording,
} from '../utils/livekit';
import {
  mapLiveKitIngressError,
  shouldRetryIngressAfterDeletingExisting,
} from '../utils/livekitErrors';
import Recording, { IRecording, RecordingStatus, RecordingAccess } from '../models/Recording';
import { getRecordingObjectKey, uploadObject, deleteObject, getAgoraRoomImageKey } from '../utils/spaces';
import { processImage } from '../utils/imageProcessor';
import { emitLiveRoomsUpdated } from '../utils/socket';
import { resolvePodcastEpisode } from '../utils/syraPodcast';
import {
  fetchUpstreamFollowingRedirects,
  contentTypeFamily,
  SsrfRejection,
} from '../utils/safeUpstreamFetch';

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} not allowed. Allowed: ${ALLOWED_IMAGE_TYPES.join(', ')}`));
    }
  }
});

const router = Router();

type CreatedIngress = Awaited<ReturnType<typeof createRoomUrlIngress>>;
type RoomOwnershipFields = Pick<IRoom, 'host' | 'ownerType' | 'houseId'>;

interface IngressReplacementResult {
  ingress: CreatedIngress;
  previousIngressId?: string;
  previousDeletedBeforeCreate: boolean;
}

type InternalStreamFields = {
  activeStreamUrl?: unknown;
  activeIngressId?: unknown;
  rtmpUrl?: unknown;
  rtmpStreamKey?: unknown;
};

export function stripInternalStreamFields<T extends InternalStreamFields>(room: T): T {
  delete room.activeStreamUrl;
  delete room.activeIngressId;
  delete room.rtmpUrl;
  delete room.rtmpStreamKey;
  return room;
}

async function canManageRoom(room: RoomOwnershipFields, userId: string): Promise<boolean> {
  if (room.host === userId) {
    return true;
  }

  if (room.ownerType === OwnerType.HOUSE) {
    if (!room.houseId) {
      return false;
    }

    const house = await House.findById(room.houseId);
    return Boolean(house?.hasRole(userId, HouseMemberRole.ADMIN));
  }

  if (room.ownerType === OwnerType.AGORA) {
    return isAdmin(userId);
  }

  return false;
}

async function sendForbiddenUnlessRoomManager(
  room: RoomOwnershipFields,
  userId: string,
  res: Response,
  message: string
): Promise<boolean> {
  if (await canManageRoom(room, userId)) {
    return true;
  }

  res.status(403).json({ message });
  return false;
}

function emitStreamStarted(
  roomId: string,
  room: Pick<IRoom, 'streamTitle' | 'streamImage' | 'streamDescription' | 'streamStartedAt' | 'streamDurationSec'>,
) {
  const io = global.io;
  if (!io) return;

  const roomPayload = {
    roomId,
    title: room.streamTitle || undefined,
    image: room.streamImage || undefined,
    description: room.streamDescription || undefined,
    // Progress-card inputs: when the stream started (ISO) and its total length
    // (seconds) when known. The client can render elapsed/total from these
    // alone, without re-fetching the room.
    startedAt: room.streamStartedAt ? room.streamStartedAt.toISOString() : undefined,
    durationSec: typeof room.streamDurationSec === 'number' ? room.streamDurationSec : undefined,
    timestamp: new Date().toISOString(),
  };

  io.of('/rooms').to(`room:${roomId}`).emit('room:stream:started', roomPayload);
}

function emitStreamStopped(roomId: string) {
  const io = global.io;
  if (!io) return;

  const roomPayload = {
    roomId,
    timestamp: new Date().toISOString(),
  };

  io.of('/rooms').to(`room:${roomId}`).emit('room:stream:stopped', roomPayload);
}

function sendLiveKitIngressError(
  res: Response,
  error: unknown,
  operation: string,
  context: { roomId: string; userId?: string }
) {
  const mapped = mapLiveKitIngressError(error);
  logger.warn('LiveKit stream ingress operation failed', {
    operation,
    roomId: context.roomId,
    userId: context.userId,
    status: mapped.liveKit.status,
    code: mapped.liveKit.code,
    message: mapped.liveKit.message,
    responseCode: mapped.code,
  });

  return res.status(mapped.statusCode).json({
    message: mapped.message,
    code: mapped.code,
  });
}

async function createIngressReplacingExisting(
  room: IRoom,
  roomId: string,
  createIngress: () => Promise<CreatedIngress>
): Promise<IngressReplacementResult> {
  const previousIngressId = room.activeIngressId || undefined;

  try {
    return {
      ingress: await createIngress(),
      previousIngressId,
      previousDeletedBeforeCreate: false,
    };
  } catch (error) {
    if (!previousIngressId || !shouldRetryIngressAfterDeletingExisting(error)) {
      throw error;
    }

    logger.warn('Retrying stream ingress creation after deleting existing ingress', {
      roomId,
      ingressId: previousIngressId,
    });
    await deleteIngress(previousIngressId);

    return {
      ingress: await createIngress(),
      previousIngressId,
      previousDeletedBeforeCreate: true,
    };
  }
}

async function cleanupPreviousIngressAfterReplacement(roomId: string, result: IngressReplacementResult) {
  if (
    result.previousIngressId &&
    !result.previousDeletedBeforeCreate &&
    result.previousIngressId !== result.ingress.ingressId
  ) {
    await deleteIngress(result.previousIngressId);
    logger.info(`Replaced previous ingress for room ${roomId}: ${result.previousIngressId}`);
  }
}

/** Metadata persisted alongside a URL ingress. `durationSec` is known only for
 * finite sources (e.g. a podcast episode); open-ended URLs omit it. */
type UrlIngressMeta = {
  url: string;
  title?: string;
  image?: string;
  description?: string;
  durationSec?: number;
};

/** Res-free result of {@link applyUrlIngressToRoom}. */
type ApplyUrlIngressOutcome =
  | { ok: true; ingressId: string; url: string }
  | { ok: false; error: unknown };

/**
 * Clear EVERY stream field on a room in one place, so the "stop / teardown"
 * paths (DELETE /stream, /stop, /end, queue-drained, webhook) can never drift
 * out of sync as fields are added. Includes the progress fields
 * (`streamStartedAt`, `streamDurationSec`) and the `podcastQueue`.
 */
function clearRoomStreamFields(room: IRoom): void {
  room.activeIngressId = undefined;
  room.activeStreamUrl = undefined;
  room.streamTitle = undefined;
  room.streamImage = undefined;
  room.streamDescription = undefined;
  room.rtmpUrl = undefined;
  room.rtmpStreamKey = undefined;
  room.streamStartedAt = undefined;
  room.streamDurationSec = undefined;
  room.podcastQueue = undefined;
}

/**
 * Start (or replace) a LiveKit URL ingress for a live room and persist it —
 * the res-FREE core shared by `POST /:id/stream`, `POST /:id/stream/podcast`,
 * `POST /:id/stream/podcast/next`, and the LiveKit auto-advance webhook.
 *
 * Callers MUST perform their own auth / manager / `RoomStatus.LIVE` validation
 * and pass an already-validated `meta.url`; this owns only the ingress +
 * persistence + socket-broadcast half. `meta.title` / `meta.image` /
 * `meta.description` are stored verbatim (callers normalize); the RTMP fields
 * are cleared (starting a URL ingress switches the room out of RTMP mode);
 * `streamStartedAt` is stamped now and `streamDurationSec` mirrors
 * `meta.durationSec` (undefined for open-ended URLs). On a LiveKit failure it
 * returns `{ ok: false, error }` WITHOUT persisting — the caller maps the error.
 */
async function applyUrlIngressToRoom(
  room: IRoom,
  id: string,
  meta: UrlIngressMeta,
): Promise<ApplyUrlIngressOutcome> {
  let ingressResult: IngressReplacementResult;
  try {
    await ensureLiveKitRoomForRoom(id, room.maxParticipants);
    ingressResult = await createIngressReplacingExisting(room, id, () =>
      createRoomUrlIngress(id, meta.url)
    );
    await cleanupPreviousIngressAfterReplacement(id, ingressResult);
  } catch (liveKitError) {
    return { ok: false, error: liveKitError };
  }

  // Persist ingress info + metadata (clear RTMP fields if switching modes)
  room.activeIngressId = ingressResult.ingress.ingressId;
  room.activeStreamUrl = meta.url;
  room.rtmpUrl = undefined;
  room.rtmpStreamKey = undefined;
  room.streamTitle = meta.title;
  room.streamImage = meta.image;
  room.streamDescription = meta.description;
  room.streamStartedAt = new Date();
  room.streamDurationSec = typeof meta.durationSec === 'number' ? meta.durationSec : undefined;
  await room.save();

  logger.info(`Live stream started in room ${id}: ${meta.url}`);

  // Notify participants via socket (no URL -- only metadata)
  emitStreamStarted(id, room);

  return { ok: true, ingressId: ingressResult.ingress.ingressId, url: meta.url };
}

/**
 * HTTP wrapper over {@link applyUrlIngressToRoom} for the host-supplied-URL
 * route: starts the ingress and writes the standard `{ message, ingressId, url }`
 * response, or maps a LiveKit failure via {@link sendLiveKitIngressError}.
 */
async function startUrlIngressForRoom(
  room: IRoom,
  id: string,
  meta: UrlIngressMeta,
  res: Response,
  userId: string,
): Promise<void> {
  const outcome = await applyUrlIngressToRoom(room, id, meta);
  if (!outcome.ok) {
    sendLiveKitIngressError(res, outcome.error, 'create-url-ingress', { roomId: id, userId });
    return;
  }

  res.json({
    message: 'Stream started successfully',
    ingressId: outcome.ingressId,
    url: outcome.url,
  });
}

/**
 * Bounded time-to-first-byte deadline for the pre-ingress audio-URL probe.
 * Kept short: this only confirms the upstream is alive and serving audio, not
 * that the whole file downloads.
 */
const AUDIO_URL_VALIDATION_TIMEOUT_MS = 6_000;

/** HLS playlist content-types a URL ingress can consume as audio. */
const HLS_PLAYLIST_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'application/mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
]);

/**
 * Generic binary content-types podcast CDNs frequently serve for a direct
 * audio file instead of a precise `audio/*` label. Accepted so the safety layer
 * rejects only clearly-wrong bodies (HTML error pages, images, video) without
 * dropping legitimate episodes served as an opaque download.
 */
const OPAQUE_BINARY_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'application/octet-stream',
  'binary/octet-stream',
]);

function isPlayableAudioContentType(family: string): boolean {
  return (
    family.startsWith('audio/') ||
    HLS_PLAYLIST_CONTENT_TYPES.has(family) ||
    OPAQUE_BINARY_CONTENT_TYPES.has(family)
  );
}

type AudioUrlValidation = { ok: true } | { ok: false; status: 400 | 502; message: string };

/**
 * SSRF-guarded, bounded pre-ingress probe of a resolved audio URL. Confirms the
 * URL is a reachable PUBLIC http(s) endpoint (every hop re-validated by
 * {@link fetchUpstreamFollowingRedirects} / `assertSafePublicUrl`, IP-pinned to
 * close the DNS-rebind window) serving audio — so we never hand LiveKit a dead,
 * internal, or non-audio ingress URL.
 *
 * A tiny `bytes=0-1` range request keeps it bounded; only the status line +
 * headers are inspected and the body is destroyed immediately. Mapping:
 *  - blocked/malformed target, upstream 4xx, or non-audio body → `400` (the URL
 *    is invalid for our purposes);
 *  - unreachable / timeout / upstream 5xx → `502`.
 */
async function validatePlayableAudioUrl(url: string): Promise<AudioUrlValidation> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUDIO_URL_VALIDATION_TIMEOUT_MS);
  try {
    const { response } = await fetchUpstreamFollowingRedirects(
      url,
      { range: 'bytes=0-1' },
      controller.signal,
    );
    const status = response.statusCode ?? 0;
    const family = contentTypeFamily(response.headers);
    // Only the status line + headers are needed; never drain the media body.
    response.destroy();

    if (status >= 400 && status < 500) {
      return { ok: false, status: 400, message: 'Podcast episode audio is not available' };
    }
    if (status < 200 || status >= 300) {
      return { ok: false, status: 502, message: 'Podcast episode audio is temporarily unreachable' };
    }
    if (!isPlayableAudioContentType(family)) {
      return { ok: false, status: 400, message: 'Resolved URL is not playable audio' };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof SsrfRejection) {
      logger.warn('Rejected non-public podcast audio URL', { reason: err.message });
      return { ok: false, status: 400, message: 'Podcast episode audio URL is not allowed' };
    }
    logger.warn('Podcast audio URL unreachable', {
      reason: err instanceof Error ? err.message : 'unknown',
    });
    return { ok: false, status: 502, message: 'Podcast episode audio is temporarily unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/** Res-free outcome shape shared by every podcast stream-start path. */
type PodcastStreamOutcome =
  | { ok: true; ingressId: string; url: string }
  | { ok: false; status: number; body: { message: string; code?: string } };

/**
 * The full server-side podcast-episode → live-stream pipeline (res-free):
 * tri-state resolve → SSRF-guarded audio probe → URL ingress. Shared by the
 * `POST /:id/stream/podcast` route, the `/next` manual-advance route, and the
 * LiveKit auto-advance webhook so all three enforce the identical policy.
 *
 * Failure mapping: `not_found` → 404, `unavailable` → 503, non-audio/blocked
 * URL → 400, unreachable upstream → 502, LiveKit ingress failure → the mapped
 * LiveKit status. The caller MUST have already set `room.podcastQueue` to the
 * post-start remainder (persisted atomically by the ingress save on success).
 */
async function startPodcastEpisodeStream(
  room: IRoom,
  id: string,
  episodeId: string,
  expectedPodcastId: string | undefined,
  userId: string,
): Promise<PodcastStreamOutcome> {
  const resolved = await resolvePodcastEpisode(episodeId, expectedPodcastId);
  if (resolved.status === 'not_found') {
    return { ok: false, status: 404, body: { message: 'Podcast episode not found' } };
  }
  if (resolved.status === 'unavailable') {
    return { ok: false, status: 503, body: { message: 'Podcast service is temporarily unavailable' } };
  }

  const validation = await validatePlayableAudioUrl(resolved.episode.audioUrl);
  if (!validation.ok) {
    return { ok: false, status: validation.status, body: { message: validation.message } };
  }

  const outcome = await applyUrlIngressToRoom(room, id, {
    url: resolved.episode.audioUrl,
    title: resolved.episode.title,
    image: resolved.episode.artworkUrl,
    description: undefined,
    durationSec: resolved.episode.durationSec,
  });
  if (!outcome.ok) {
    const mapped = mapLiveKitIngressError(outcome.error);
    logger.warn('LiveKit stream ingress operation failed', {
      operation: 'create-podcast-ingress',
      roomId: id,
      userId,
      status: mapped.liveKit.status,
      code: mapped.liveKit.code,
      message: mapped.liveKit.message,
    });
    return { ok: false, status: mapped.statusCode, body: { message: mapped.message, code: mapped.code } };
  }

  return { ok: true, ingressId: outcome.ingressId, url: outcome.url };
}

/** Upper bound on episodes queued behind the current one (DoS / abuse guard). */
const MAX_PODCAST_QUEUE_LENGTH = 100;

type ParsedPodcastQueue =
  | { ok: true; queue: PodcastQueueItem[] }
  | { ok: false; message: string };

/**
 * Validate + normalize an optional client-supplied podcast queue. Each item
 * must carry a non-empty `episodeId`; `syraPodcastId` is optional (used for the
 * show cross-check at play-time). Absent/null ⇒ an empty queue. The playable
 * audio URL is never accepted from the client — only opaque ids.
 */
function parsePodcastQueue(input: unknown): ParsedPodcastQueue {
  if (input === undefined || input === null) {
    return { ok: true, queue: [] };
  }
  if (!Array.isArray(input)) {
    return { ok: false, message: 'queue must be an array' };
  }
  if (input.length > MAX_PODCAST_QUEUE_LENGTH) {
    return { ok: false, message: `queue cannot exceed ${MAX_PODCAST_QUEUE_LENGTH} episodes` };
  }

  const queue: PodcastQueueItem[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') {
      return { ok: false, message: 'each queue item must be an object' };
    }
    const obj = item as Record<string, unknown>;
    const episodeId = typeof obj.episodeId === 'string' ? obj.episodeId.trim() : '';
    if (!episodeId) {
      return { ok: false, message: 'each queue item requires an episodeId' };
    }
    const syraPodcastId =
      typeof obj.syraPodcastId === 'string' && obj.syraPodcastId.trim() ? obj.syraPodcastId.trim() : undefined;
    queue.push(syraPodcastId ? { syraPodcastId, episodeId } : { episodeId });
  }
  return { ok: true, queue };
}

/**
 * Stop the room's current stream (res-free): delete the active ingress, clear
 * every stream field (via {@link clearRoomStreamFields}), persist, and broadcast
 * `room:stream:stopped`. Safe to call when nothing is streaming — the ingress
 * delete is skipped and the field clears are no-ops.
 */
async function stopRoomStream(room: IRoom, id: string): Promise<void> {
  if (room.activeIngressId) {
    await deleteIngress(room.activeIngressId);
  }
  clearRoomStreamFields(room);
  await room.save();
  logger.info(`Live stream stopped in room ${id}`);
  emitStreamStopped(id);
}

/** Res-free result of {@link advancePodcastQueueForRoom}. */
export type AdvancePodcastResult =
  | { kind: 'ended' }
  | { kind: 'started'; ingressId: string; url: string }
  | { kind: 'error'; status: number; body: { message: string; code?: string } };

/**
 * Advance a room to the next queued podcast episode, or stop the stream when the
 * queue is empty. Shared by `POST /:id/stream/podcast/next` (manual) and the
 * LiveKit `ingress_ended` webhook (auto-advance).
 *
 * Pops the head of `room.podcastQueue`, sets the room's queue to the remainder
 * in memory (persisted atomically by the ingress save only on a SUCCESSFUL
 * start — so a failed start leaves the persisted queue untouched, keeping the
 * head for a retry), then runs it through {@link startPodcastEpisodeStream}.
 * When the queue is empty it stops the stream via {@link stopRoomStream}.
 */
export async function advancePodcastQueueForRoom(
  room: IRoom,
  id: string,
  userId: string,
): Promise<AdvancePodcastResult> {
  const queue: PodcastQueueItem[] = Array.isArray(room.podcastQueue)
    ? room.podcastQueue.map((item) => ({ syraPodcastId: item.syraPodcastId, episodeId: item.episodeId }))
    : [];

  const head = queue.shift();
  if (!head) {
    await stopRoomStream(room, id);
    return { kind: 'ended' };
  }

  room.podcastQueue = queue.length > 0 ? queue : undefined;

  const outcome = await startPodcastEpisodeStream(room, id, head.episodeId, head.syraPodcastId, userId);
  if (!outcome.ok) {
    return { kind: 'error', status: outcome.status, body: outcome.body };
  }
  return { kind: 'started', ingressId: outcome.ingressId, url: outcome.url };
}

// --- Recording auto-stop timers (1 hour max) ---
const MAX_RECORDING_DURATION_MS = 60 * 60 * 1000; // 1 hour
const RECORDING_EXPIRY_MS = 6 * 30 * 24 * 60 * 60 * 1000; // ~6 months

const recordingTimers = new Map<string, NodeJS.Timeout>();

function scheduleRecordingAutoStop(roomId: string, egressId: string, recordingId: string) {
  clearRecordingAutoStop(roomId);

  const timer = setTimeout(async () => {
    try {
      await stopRoomRecording(egressId);

      const recording = await Recording.findById(recordingId);
      if (recording && recording.status === RecordingStatus.RECORDING) {
        recording.status = RecordingStatus.READY;
        recording.stoppedAt = new Date();
        recording.durationMs = recording.stoppedAt.getTime() - recording.startedAt.getTime();
        await recording.save();
      }

      await Room.findByIdAndUpdate(roomId, { recordingEgressId: null });

      const io = global.io;
      if (io) {
        io.of('/rooms').to(`room:${roomId}`).emit('room:recording:stopped', {
          roomId,
          recordingId,
          reason: 'max_duration',
          timestamp: new Date().toISOString(),
        });
      }

      logger.info(`Recording auto-stopped after 1 hour for room ${roomId}`);
    } catch (error) {
      logger.error(`Failed to auto-stop recording for room ${roomId}:`, error);
    } finally {
      recordingTimers.delete(roomId);
    }
  }, MAX_RECORDING_DURATION_MS);

  recordingTimers.set(roomId, timer);
}

function clearRecordingAutoStop(roomId: string) {
  const timer = recordingTimers.get(roomId);
  if (timer) {
    clearTimeout(timer);
    recordingTimers.delete(roomId);
  }
}

/**
 * Helper: start recording for a room and return the Recording doc.
 * Non-fatal: returns null on failure so room lifecycle can proceed.
 */
async function startRecordingForRoom(room: IRoom): Promise<IRecording> {
  const recording = new Recording({
    roomId: String(room._id),
    roomTitle: room.title,
    host: room.host,
    status: RecordingStatus.RECORDING,
    egressId: 'pending',
    objectKey: 'pending',
    startedAt: new Date(),
    access: RecordingAccess.PUBLIC,
    expiresAt: new Date(Date.now() + RECORDING_EXPIRY_MS),
  });
  await recording.save();

  const objectKey = getRecordingObjectKey(String(room._id), String(recording._id));
  recording.objectKey = objectKey;

  const egressId = await startRoomRecording(String(room._id), objectKey);
  recording.egressId = egressId;
  await recording.save();

  room.recordingEgressId = egressId;
  await room.save();

  scheduleRecordingAutoStop(String(room._id), egressId, String(recording._id));

  return recording;
}

/**
 * Helper: stop recording for a room. Non-fatal.
 */
async function stopRecordingForRoom(room: IRoom, reason: string = 'room_ended') {
  if (!room.recordingEgressId) return;

  const egressId = room.recordingEgressId;
  try {
    await stopRoomRecording(egressId);
  } catch (err) {
    logger.warn(`Failed to stop egress ${egressId}, may have already stopped:`, err);
  }

  const recording = await Recording.findOne({ egressId });
  if (recording && recording.status === RecordingStatus.RECORDING) {
    recording.status = RecordingStatus.READY;
    recording.stoppedAt = new Date();
    recording.durationMs = recording.stoppedAt.getTime() - recording.startedAt.getTime();
    recording.participantIds = room.participants || [];
    await recording.save();
  }

  clearRecordingAutoStop(String(room._id));
  room.recordingEgressId = undefined;

  const io = global.io;
  if (io) {
    io.of('/rooms').to(`room:${room._id}`).emit('room:recording:stopped', {
      roomId: String(room._id),
      recordingId: recording ? String(recording._id) : undefined,
      reason,
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Create a room
 * POST /api/rooms
 */
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const {
      title,
      description,
      scheduledStart,
      maxParticipants,
      topic,
      tags,
      speakerPermission,
      type,
      ownerType,
      broadcastKind,
      houseId,
      recordingEnabled,
    } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      return res.status(400).json({ message: 'Title is required' });
    }

    // Validate type
    const roomType: RoomType = type && Object.values(RoomType).includes(type)
      ? type
      : RoomType.TALK;

    // Validate ownerType
    const roomOwnerType: OwnerType = ownerType && Object.values(OwnerType).includes(ownerType)
      ? ownerType
      : OwnerType.PROFILE;

    // Reject agora-owned rooms from this endpoint (admin-only)
    if (roomOwnerType === OwnerType.AGORA) {
      return res.status(403).json({ message: 'Agora-owned rooms can only be created by admins' });
    }

    // Validate house ownership permission
    if (roomOwnerType === OwnerType.HOUSE) {
      if (!houseId || typeof houseId !== 'string') {
        return res.status(400).json({ message: 'houseId is required when ownerType is house' });
      }

      const house = await House.findById(houseId);
      if (!house) {
        return res.status(404).json({ message: 'House not found' });
      }

      // User must have HOST role or higher in the house
      if (!house.hasRole(userId, HouseMemberRole.HOST)) {
        return res.status(403).json({ message: 'You must be a host or higher in this house to create rooms' });
      }
    }

    // Validate scheduledStart if provided
    let scheduledStartDate: Date | undefined;
    if (scheduledStart) {
      scheduledStartDate = new Date(scheduledStart);
      if (isNaN(scheduledStartDate.getTime())) {
        return res.status(400).json({ message: 'Invalid scheduledStart date' });
      }
    }

    // For broadcast rooms, speakers array should only contain the host
    // and speakerPermission is always 'invited'
    const isBroadcast = roomType === RoomType.BROADCAST;

    const roomSpeakerPermission = isBroadcast
      ? SpeakerPermission.INVITED
      : (speakerPermission && Object.values(SpeakerPermission).includes(speakerPermission)
        ? speakerPermission
        : SpeakerPermission.INVITED);

    // Resolve broadcastKind for broadcast rooms
    let resolvedBroadcastKind: BroadcastKind | undefined;
    if (isBroadcast) {
      resolvedBroadcastKind = broadcastKind && Object.values(BroadcastKind).includes(broadcastKind)
        ? broadcastKind
        : BroadcastKind.USER;
    }

    // Create room
    const room = new Room({
      title: title.trim(),
      description: description ? String(description).trim() : undefined,
      host: userId,
      type: roomType,
      ownerType: roomOwnerType,
      broadcastKind: resolvedBroadcastKind,
      houseId: roomOwnerType === OwnerType.HOUSE ? houseId : undefined,
      status: RoomStatus.SCHEDULED,
      participants: [],
      speakers: [userId], // Host is automatically a speaker
      maxParticipants: maxParticipants && typeof maxParticipants === 'number'
        ? Math.min(Math.max(maxParticipants, 1), 10000)
        : 100,
      scheduledStart: scheduledStartDate,
      topic: topic ? String(topic).trim() : undefined,
      tags: Array.isArray(tags) ? tags.map((t: unknown) => String(t).trim()).filter(Boolean) : [],
      speakerPermission: roomSpeakerPermission,
      recordingEnabled: recordingEnabled !== false, // default true
      stats: {
        peakListeners: 0,
        totalJoined: 0,
      },
    });

    await room.save();

    logger.info(`Room created: ${room._id} by ${userId} (type=${roomType}, ownerType=${roomOwnerType})`);

    res.status(201).json({
      message: 'Room created successfully',
      room,
    });
  } catch (error) {
    logger.error('Error creating room:', { userId: req.user?.id, error });
    res.status(500).json({
      message: 'Error creating room',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * List active/scheduled rooms
 * GET /api/rooms
 * Query params: status, host, type, ownerType, houseId, limit, cursor
 */
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { status, host, type, ownerType, houseId, limit = '20', cursor } = req.query;

    const query: Record<string, unknown> = {
      archived: { $ne: true },
    };

    // Filter by status
    if (status && typeof status === 'string') {
      const validStatuses = Object.values(RoomStatus);
      if (validStatuses.includes(status as RoomStatus)) {
        query.status = status;
      }
    } else {
      // By default, show live and scheduled rooms (not ended)
      query.status = { $in: [RoomStatus.LIVE, RoomStatus.SCHEDULED] };
    }

    // Filter by host
    if (host && typeof host === 'string') {
      query.host = host;
    }

    // Filter by type
    if (type && typeof type === 'string') {
      const validTypes = Object.values(RoomType);
      if (validTypes.includes(type as RoomType)) {
        query.type = type;
      }
    }

    // Filter by ownerType
    if (ownerType && typeof ownerType === 'string') {
      const validOwnerTypes = Object.values(OwnerType);
      if (validOwnerTypes.includes(ownerType as OwnerType)) {
        query.ownerType = ownerType;
      }
    }

    // Filter by houseId
    if (houseId && typeof houseId === 'string') {
      query.houseId = houseId;
    }

    // Cursor-based pagination
    if (cursor && typeof cursor === 'string') {
      query._id = { $lt: cursor };
    }

    const limitNum = Math.min(Math.max(parseInt(limit as string, 10) || 20, 1), 100);

    const rooms = await Room.find(query)
      .sort({ createdAt: -1 })
      .limit(limitNum + 1)
      .lean();

    // Check if there are more results
    const hasMore = rooms.length > limitNum;
    const roomsToReturn = hasMore ? rooms.slice(0, limitNum) : rooms;
    const nextCursor = hasMore && roomsToReturn.length > 0
      ? roomsToReturn[roomsToReturn.length - 1]._id.toString()
      : undefined;

    res.json({
      rooms: roomsToReturn.map((room) => stripInternalStreamFields(room)),
      hasMore,
      nextCursor,
    });
  } catch (error) {
    logger.error('Error fetching rooms:', { userId: req.user?.id, error, query: req.query });
    res.status(500).json({
      message: 'Error fetching rooms',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get top hosts by total listeners across recordings
 * GET /api/rooms/top-hosts
 * Query params: limit (default 10, max 20)
 */
router.get('/top-hosts', async (req: AuthRequest, res: Response) => {
  try {
    const { limit = '10' } = req.query;
    const limitNum = Math.min(Math.max(parseInt(limit as string, 10) || 10, 1), 20);

    const hosts = await Recording.aggregate([
      { $match: { status: RecordingStatus.READY } },
      { $group: {
          _id: '$host',
          roomCount: { $sum: 1 },
          totalListeners: { $sum: { $size: '$participantIds' } },
      }},
      { $sort: { totalListeners: -1 } },
      { $limit: limitNum },
      { $project: { _id: 0, userId: '$_id', roomCount: 1, totalListeners: 1 } },
    ]);

    res.json({ hosts });
  } catch (error) {
    logger.error('Error fetching top hosts:', { userId: req.user?.id, error });
    res.status(500).json({
      message: 'Error fetching top hosts',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get room details
 * GET /api/rooms/:id
 */
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const room = await Room.findById(id).lean();

    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    const userId = req.user?.id;
    const canViewInternalStreamFields = userId
      ? await canManageRoom(room, userId)
      : false;

    if (!canViewInternalStreamFields) {
      stripInternalStreamFields(room);
    }

    res.json({ room });
  } catch (error) {
    logger.error('Error fetching room:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error fetching room',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Start a room (room manager only)
 * POST /api/rooms/:id/start
 */
router.post('/:id/start', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await Room.findById(id);

    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (!(await sendForbiddenUnlessRoomManager(room, userId, res, 'Only a room manager can start the room'))) {
      return;
    }

    // Can only start scheduled rooms
    if (room.status !== RoomStatus.SCHEDULED) {
      return res.status(400).json({
        message: `Cannot start room with status: ${room.status}`,
      });
    }

    // For broadcast rooms, ensure speakers array only contains the primary host.
    if (room.type === RoomType.BROADCAST) {
      room.speakers = [room.host];
      room.speakerPermission = SpeakerPermission.INVITED;
    }

    // Create LiveKit room before going live
    try {
      await createLiveKitRoomForRoom(String(id), room.maxParticipants);
    } catch (lkErr) {
      logger.error(`Failed to create LiveKit room for room ${id}, starting anyway:`, lkErr);
    }

    // Update room status
    room.status = RoomStatus.LIVE;
    room.startedAt = new Date();
    await room.save();

    logger.info(`Room started: ${room._id} (type=${room.type})`);

    // Auto-start recording if enabled
    let recordingDoc = null;
    if (room.recordingEnabled) {
      try {
        recordingDoc = await startRecordingForRoom(room);
        logger.info(`Auto-started recording for room ${room._id}, egressId: ${recordingDoc.egressId}`);
      } catch (recErr) {
        logger.error(`Failed to auto-start recording for room ${room._id}:`, recErr);
        // Non-fatal: room goes live even if recording fails
      }
    }

    // Notify the room's clients that recording started (when enabled).
    const io = global.io;
    if (io && recordingDoc) {
      io.of('/rooms').to(`room:${id}`).emit('room:recording:started', {
        roomId: id,
        recordingId: String(recordingDoc._id),
        timestamp: new Date().toISOString(),
      });
    }

    // Signal the live-rooms widget: a room just went live.
    emitLiveRoomsUpdated('created');

    res.json({
      message: 'Room started successfully',
      room,
    });
  } catch (error) {
    logger.error('Error starting room:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error starting room',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * End a room (room manager only)
 * POST /api/rooms/:id/end
 */
router.post('/:id/end', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await Room.findById(id);

    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (!(await sendForbiddenUnlessRoomManager(room, userId, res, 'Only a room manager can end the room'))) {
      return;
    }

    // Can only end live rooms
    if (room.status !== RoomStatus.LIVE) {
      return res.status(400).json({
        message: `Cannot end room with status: ${room.status}`,
      });
    }

    // Stop active recording if any
    try {
      await stopRecordingForRoom(room, 'room_ended');
    } catch (recErr) {
      logger.error(`Error stopping recording for room ${id}:`, recErr);
    }

    // Update room status
    room.status = RoomStatus.ENDED;
    room.endedAt = new Date();

    // Clean up active ingress if any
    if (room.activeIngressId) {
      deleteIngress(room.activeIngressId).catch((err) => {
        logger.error(`Failed to delete ingress for room ${id}:`, err);
      });
      clearRoomStreamFields(room);
    }

    await room.save();

    // Clean up LiveKit room
    deleteLiveKitRoomForRoom(String(id)).catch((err) => {
      logger.error(`Failed to delete LiveKit room for room ${id}:`, err);
    });

    logger.info(`Room ended: ${room._id}`);

    // Signal the live-rooms widget: a room left the live set.
    emitLiveRoomsUpdated('ended');

    res.json({
      message: 'Room ended successfully',
      room,
    });
  } catch (error) {
    logger.error('Error ending room:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error ending room',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Stop a live session (room manager only) — returns room to scheduled status so it can
 * be reused.  Cleans up LiveKit room and any active ingress, but does NOT
 * permanently end the room.
 * POST /api/rooms/:id/stop
 */
router.post('/:id/stop', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await Room.findById(id);

    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (!(await sendForbiddenUnlessRoomManager(room, userId, res, 'Only a room manager can stop the room'))) {
      return;
    }

    if (room.status !== RoomStatus.LIVE) {
      return res.status(400).json({
        message: `Cannot stop room with status: ${room.status}`,
      });
    }

    // Stop active recording if any
    try {
      await stopRecordingForRoom(room, 'room_stopped');
    } catch (recErr) {
      logger.error(`Error stopping recording for room ${id}:`, recErr);
    }

    // Reset to scheduled so the host can go live again later
    room.status = RoomStatus.SCHEDULED;
    room.startedAt = undefined;

    // Clean up active ingress if any
    if (room.activeIngressId) {
      deleteIngress(room.activeIngressId).catch((err) => {
        logger.error(`Failed to delete ingress for room ${id}:`, err);
      });
      clearRoomStreamFields(room);
    }

    await room.save();

    // Clean up LiveKit room
    deleteLiveKitRoomForRoom(String(id)).catch((err) => {
      logger.error(`Failed to delete LiveKit room for room ${id}:`, err);
    });

    logger.info(`Room stopped (back to scheduled): ${room._id}`);

    // Signal the live-rooms widget: the room left the live set (back to scheduled).
    emitLiveRoomsUpdated('ended');

    res.json({
      message: 'Live session stopped',
      room,
    });
  } catch (error) {
    logger.error('Error stopping room:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error stopping room',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Join a room as listener
 * POST /api/rooms/:id/join
 */
router.post('/:id/join', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await Room.findById(id);

    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    // Can only join live rooms
    if (room.status !== RoomStatus.LIVE) {
      return res.status(400).json({
        message: 'Room is not currently live',
      });
    }

    // Check if already a participant
    if (room.participants.includes(userId)) {
      return res.json({
        message: 'Already joined',
        room,
      });
    }

    // Check capacity
    if (room.participants.length >= room.maxParticipants) {
      return res.status(403).json({
        message: 'Room is at maximum capacity',
      });
    }

    // Add to participants
    room.participants.push(userId);
    room.stats.totalJoined += 1;

    // Update peak listeners if necessary
    if (room.participants.length > room.stats.peakListeners) {
      room.stats.peakListeners = room.participants.length;
    }

    await room.save();

    logger.debug(`User ${userId} joined room ${id}`);

    // Signal the live-rooms widget: participant count changed.
    emitLiveRoomsUpdated('participants');

    res.json({
      message: 'Joined room successfully',
      room,
    });
  } catch (error) {
    logger.error('Error joining room:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error joining room',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Leave a room
 * POST /api/rooms/:id/leave
 */
router.post('/:id/leave', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await Room.findById(id);

    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    // Remove from participants
    room.participants = room.participants.filter(p => p !== userId);

    // If leaving as speaker, remove from speakers too (except host)
    if (room.speakers.includes(userId) && room.host !== userId) {
      room.speakers = room.speakers.filter(s => s !== userId);
    }

    await room.save();

    logger.debug(`User ${userId} left room ${id}`);

    // Signal the live-rooms widget only when a live room's count changed.
    if (room.status === RoomStatus.LIVE) {
      emitLiveRoomsUpdated('participants');
    }

    res.json({
      message: 'Left room successfully',
    });
  } catch (error) {
    logger.error('Error leaving room:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error leaving room',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Add speaker (room manager only)
 * POST /api/rooms/:id/speakers
 */
router.post('/:id/speakers', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;
    const { userId: speakerId } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!speakerId) {
      return res.status(400).json({ message: 'userId is required' });
    }

    const room = await Room.findById(id);

    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (!(await sendForbiddenUnlessRoomManager(room, userId, res, 'Only a room manager can add speakers'))) {
      return;
    }

    // Broadcast rooms do not allow adding speakers
    if (room.type === RoomType.BROADCAST) {
      return res.status(400).json({ message: 'Cannot add speakers to a broadcast room' });
    }

    // Check if already a speaker
    if (room.speakers.includes(speakerId)) {
      return res.json({
        message: 'User is already a speaker',
        room,
      });
    }

    // Add to speakers
    room.speakers.push(speakerId);
    await room.save();

    logger.info(`User ${speakerId} added as speaker in room ${id} by ${userId}`);

    res.json({
      message: 'Speaker added successfully',
      room,
    });
  } catch (error) {
    logger.error('Error adding speaker:', { userId: req.user?.id, roomId: req.params.id, speakerId: req.body.userId, error });
    res.status(500).json({
      message: 'Error adding speaker',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Remove speaker (room manager only)
 * DELETE /api/rooms/:id/speakers/:userId
 */
router.delete('/:id/speakers/:userId', async (req: AuthRequest, res: Response) => {
  try {
    const currentUserId = req.user?.id;
    const { id, userId: speakerId } = req.params;

    if (!currentUserId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await Room.findById(id);

    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (!(await sendForbiddenUnlessRoomManager(room, currentUserId, res, 'Only a room manager can remove speakers'))) {
      return;
    }

    // Cannot remove host as speaker
    if (speakerId === room.host) {
      return res.status(400).json({ message: 'Cannot remove host as speaker' });
    }

    // Remove from speakers
    const originalLength = room.speakers.length;
    room.speakers = room.speakers.filter(s => s !== speakerId);

    if (room.speakers.length === originalLength) {
      return res.status(404).json({ message: 'User is not a speaker' });
    }

    await room.save();

    logger.info(`User ${speakerId} removed as speaker from room ${id} by ${currentUserId}`);

    res.json({
      message: 'Speaker removed successfully',
      room,
    });
  } catch (error) {
    logger.error('Error removing speaker:', { userId: req.user?.id, roomId: req.params.id, speakerId: req.params.userId, error });
    res.status(500).json({
      message: 'Error removing speaker',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get a LiveKit token for joining a room's audio room
 * POST /api/rooms/:id/token
 *
 * For broadcast rooms, everyone except the host gets a listen-only token.
 */
router.post('/:id/token', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await Room.findById(id).lean();
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (room.status !== RoomStatus.LIVE) {
      return res.status(400).json({ message: 'Room is not live' });
    }

    let token: string;

    if (room.type === RoomType.BROADCAST) {
      // Broadcast rooms: only host gets publish permissions
      const isHost = room.host === userId;
      token = await generateBroadcastToken(String(id), userId, isHost);
    } else {
      // Talk / Stage rooms: determine role normally
      let role: 'host' | 'speaker' | 'listener' = 'listener';
      if (room.host === userId) {
        role = 'host';
      } else if (room.speakers.includes(userId)) {
        role = 'speaker';
      }
      token = await generateRoomToken(String(id), userId, role);
    }

    res.json({
      token,
      url: process.env.LIVEKIT_URL || '',
    });
  } catch (error) {
    logger.error('Error generating room token:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error generating token',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Start external live stream (room manager only)
 * POST /api/rooms/:id/stream
 * Body: { url: string, title?, image?, description? }
 */
router.post('/:id/stream', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;
    const { url, title, image, description } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ message: 'url is required' });
    }

    const trimmedUrl = url.trim();

    try {
      const parsed = new URL(trimmedUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return res.status(400).json({ message: 'Only http and https URLs are supported' });
      }
    } catch {
      return res.status(400).json({ message: 'Invalid URL format' });
    }

    const room = await Room.findById(id);
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (!(await sendForbiddenUnlessRoomManager(room, userId, res, 'Only a room manager can add a live stream'))) {
      return;
    }

    if (room.status !== RoomStatus.LIVE) {
      return res.status(400).json({ message: 'Room must be live to add a stream' });
    }

    await startUrlIngressForRoom(
      room,
      String(id),
      {
        url: trimmedUrl,
        title: title ? String(title).trim() : undefined,
        image: image ? String(image).trim() : undefined,
        description: description ? String(description).trim() : undefined,
      },
      res,
      userId,
    );
  } catch (error) {
    logger.error('Error starting stream:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error starting stream',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Start streaming a Syra podcast episode into the room (room manager only)
 * POST /api/rooms/:id/stream/podcast
 * Body: { syraPodcastId?: string, episodeId: string }
 *
 * Rate limiting is handled by the global Oxy limiter (`createOxyRateLimit`,
 * `app.use(rateLimiter)` in server.ts) that fronts every route — like the sibling
 * `/:id/stream` routes, this handler carries no per-route limiter of its own.
 *
 * The client sends only the episode reference — never a media URL. The backend
 * resolves the episode's playable `enclosureUrl` + metadata server-side from the
 * Syra catalog (O(1) by-id lookup), validates the audio URL is a reachable,
 * public, audio upstream (SSRF-guarded), then feeds it into the SAME LiveKit URL
 * ingress path as `POST /:id/stream`. When `syraPodcastId` is supplied it is
 * cross-checked against the resolved episode's show to reject a mismatched
 * pairing.
 *
 * An optional `queue` of `{ syraPodcastId?, episodeId }[]` (the episodes AFTER
 * this one) is persisted as `room.podcastQueue` and advanced manually via
 * `POST /:id/stream/podcast/next` or automatically when the current ingress ends.
 */
router.post('/:id/stream/podcast', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;
    const { syraPodcastId, episodeId, queue } = req.body ?? {};

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (typeof episodeId !== 'string' || !episodeId.trim()) {
      return res.status(400).json({ message: 'episodeId is required' });
    }

    if (syraPodcastId !== undefined && typeof syraPodcastId !== 'string') {
      return res.status(400).json({ message: 'syraPodcastId must be a string' });
    }

    const parsedQueue = parsePodcastQueue(queue);
    if (!parsedQueue.ok) {
      return res.status(400).json({ message: parsedQueue.message });
    }

    const trimmedEpisodeId = episodeId.trim();
    const trimmedPodcastId =
      typeof syraPodcastId === 'string' && syraPodcastId.trim() ? syraPodcastId.trim() : undefined;

    const room = await Room.findById(id);
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (!(await sendForbiddenUnlessRoomManager(room, userId, res, 'Only a room manager can add a live stream'))) {
      return;
    }

    if (room.status !== RoomStatus.LIVE) {
      return res.status(400).json({ message: 'Room must be live to add a stream' });
    }

    // Stage the remaining queue in memory; it is persisted atomically by the
    // ingress save only when the first episode actually starts.
    room.podcastQueue = parsedQueue.queue.length > 0 ? parsedQueue.queue : undefined;

    const outcome = await startPodcastEpisodeStream(room, String(id), trimmedEpisodeId, trimmedPodcastId, userId);
    if (!outcome.ok) {
      return res.status(outcome.status).json(outcome.body);
    }

    res.json({
      message: 'Stream started successfully',
      ingressId: outcome.ingressId,
      url: outcome.url,
    });
  } catch (error) {
    logger.error('Error starting podcast stream:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error starting stream',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Advance to the next queued podcast episode, or stop the stream when the queue
 * is drained (room manager only, room must be LIVE).
 * POST /api/rooms/:id/stream/podcast/next
 *
 * Pops the head of `room.podcastQueue` and drives it through the identical
 * resolve → SSRF-validate → ingress path as `POST /:id/stream/podcast`. Returns
 * `{ message, ingressId, url }` when the next episode starts, or
 * `{ message, ended: true }` when the queue was empty and the stream stopped.
 */
router.post('/:id/stream/podcast/next', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await Room.findById(id);
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (!(await sendForbiddenUnlessRoomManager(room, userId, res, 'Only a room manager can control the stream'))) {
      return;
    }

    if (room.status !== RoomStatus.LIVE) {
      return res.status(400).json({ message: 'Room must be live to advance the stream' });
    }

    const result = await advancePodcastQueueForRoom(room, String(id), userId);
    if (result.kind === 'ended') {
      return res.json({ message: 'Stream ended', ended: true });
    }
    if (result.kind === 'error') {
      return res.status(result.status).json(result.body);
    }

    res.json({
      message: 'Stream started successfully',
      ingressId: result.ingressId,
      url: result.url,
    });
  } catch (error) {
    logger.error('Error advancing podcast stream:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error advancing stream',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Stop external live stream (room manager only)
 * DELETE /api/rooms/:id/stream
 */
router.delete('/:id/stream', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await Room.findById(id);
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (!(await sendForbiddenUnlessRoomManager(room, userId, res, 'Only a room manager can remove the stream'))) {
      return;
    }

    if (!room.activeIngressId) {
      return res.status(400).json({ message: 'No active stream' });
    }

    // Delete the ingress from LiveKit
    await deleteIngress(room.activeIngressId);

    // Clear all stream fields (incl. progress + podcast queue)
    clearRoomStreamFields(room);
    await room.save();

    logger.info(`Live stream stopped in room ${id}`);

    // Notify participants via both current and legacy namespaces
    emitStreamStopped(String(id));

    res.json({ message: 'Stream stopped successfully' });
  } catch (error) {
    logger.error('Error stopping stream:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error stopping stream',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

type UpdateStreamMetadataBody = {
  url?: unknown;
  title?: unknown;
  image?: unknown;
  description?: unknown;
};

type ParsedOptionalText =
  | { ok: true; value: string | undefined }
  | { ok: false; message: string };

const parseOptionalStreamText = (value: unknown, field: string): ParsedOptionalText => {
  if (value === undefined || value === null) {
    return { ok: true, value: undefined };
  }

  if (typeof value !== 'string') {
    return { ok: false, message: `${field} must be a string` };
  }

  const trimmed = value.trim();
  return { ok: true, value: trimmed.length > 0 ? trimmed : undefined };
};

/**
 * Update stream metadata (room manager only)
 * PATCH /api/rooms/:id/stream
 * Body: { url?, title?, image?, description? }
 */
router.patch('/:id/stream', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;
    const { url, title, image, description } = req.body as UpdateStreamMetadataBody;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    let nextStreamUrl: string | undefined;
    if (url !== undefined) {
      if (typeof url !== 'string') {
        return res.status(400).json({ message: 'url must be a string' });
      }

      const trimmedUrl = url.trim();
      if (!trimmedUrl) {
        return res.status(400).json({ message: 'url cannot be empty' });
      }

      try {
        const parsed = new URL(trimmedUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          return res.status(400).json({ message: 'Only http and https URLs are supported' });
        }
      } catch {
        return res.status(400).json({ message: 'Invalid URL format' });
      }

      nextStreamUrl = trimmedUrl;
    }

    const parsedTitle = parseOptionalStreamText(title, 'title');
    if (!parsedTitle.ok) {
      return res.status(400).json({ message: parsedTitle.message });
    }

    const parsedImage = parseOptionalStreamText(image, 'image');
    if (!parsedImage.ok) {
      return res.status(400).json({ message: parsedImage.message });
    }

    const parsedDescription = parseOptionalStreamText(description, 'description');
    if (!parsedDescription.ok) {
      return res.status(400).json({ message: parsedDescription.message });
    }

    const room = await Room.findById(id);
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (!(await sendForbiddenUnlessRoomManager(room, userId, res, 'Only a room manager can update stream info'))) {
      return;
    }

    if (!room.activeIngressId && nextStreamUrl === undefined) {
      return res.status(400).json({ message: 'No active stream to update' });
    }

    if (nextStreamUrl !== undefined && nextStreamUrl !== (room.activeStreamUrl ?? undefined)) {
      if (room.status !== RoomStatus.LIVE) {
        return res.status(400).json({ message: 'Room must be live to update stream URL' });
      }

      let ingressResult: IngressReplacementResult;
      try {
        await ensureLiveKitRoomForRoom(String(id), room.maxParticipants);
        ingressResult = await createIngressReplacingExisting(room, String(id), () =>
          createRoomUrlIngress(String(id), nextStreamUrl)
        );
        await cleanupPreviousIngressAfterReplacement(String(id), ingressResult);
      } catch (liveKitError) {
        return sendLiveKitIngressError(res, liveKitError, 'update-url-ingress', {
          roomId: String(id),
          userId,
        });
      }

      room.activeIngressId = ingressResult.ingress.ingressId;
      room.activeStreamUrl = nextStreamUrl;
      room.rtmpUrl = undefined;
      room.rtmpStreamKey = undefined;
    }

    // Update metadata fields
    if (title !== undefined) room.streamTitle = parsedTitle.value;
    if (image !== undefined) room.streamImage = parsedImage.value;
    if (description !== undefined) room.streamDescription = parsedDescription.value;
    await room.save();

    logger.info(`Stream metadata updated for room ${id}`);

    // Notify participants via socket with updated metadata
    emitStreamStarted(String(id), room);

    res.json({ message: 'Stream info updated', url: room.activeStreamUrl || null });
  } catch (error) {
    logger.error('Error updating stream metadata:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error updating stream info',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Generate RTMP stream key (room manager only)
 * POST /api/rooms/:id/stream/rtmp
 * Body: { title?, image?, description? }
 */
router.post('/:id/stream/rtmp', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;
    const { title, image, description } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await Room.findById(id);
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (!(await sendForbiddenUnlessRoomManager(room, userId, res, 'Only a room manager can configure streaming'))) {
      return;
    }

    if (room.status !== RoomStatus.LIVE) {
      return res.status(400).json({ message: 'Room must be live to configure streaming' });
    }

    let ingressResult: IngressReplacementResult;
    try {
      await ensureLiveKitRoomForRoom(String(id), room.maxParticipants);
      ingressResult = await createIngressReplacingExisting(room, String(id), () =>
        createRoomRtmpIngress(String(id))
      );
      await cleanupPreviousIngressAfterReplacement(String(id), ingressResult);
    } catch (liveKitError) {
      return sendLiveKitIngressError(res, liveKitError, 'create-rtmp-ingress', {
        roomId: String(id),
        userId,
      });
    }

    // LiveKit may return an empty url if the RTMP service doesn't have a
    // public URL configured.  Derive a fallback from LIVEKIT_URL.
    let rtmpUrl = ingressResult.ingress.url || '';
    if (!rtmpUrl) {
      const host = (process.env.LIVEKIT_URL || '')
        .replace(/^wss?:\/\//, '')
        .replace(/\/+$/, '');
      if (host) rtmpUrl = `rtmp://${host}:1935/live`;
    }

    // Persist ingress info + metadata (clear URL mode fields)
    room.activeIngressId = ingressResult.ingress.ingressId;
    room.activeStreamUrl = undefined;
    room.rtmpUrl = rtmpUrl;
    room.rtmpStreamKey = ingressResult.ingress.streamKey;
    room.streamTitle = title ? String(title).trim() : undefined;
    room.streamImage = image ? String(image).trim() : undefined;
    room.streamDescription = description ? String(description).trim() : undefined;
    await room.save();

    logger.info(`RTMP ingress created for room ${id}: ${ingressResult.ingress.ingressId}`);

    // Notify participants via socket (metadata only -- no credentials)
    emitStreamStarted(String(id), room);

    res.json({
      message: 'RTMP stream key generated',
      rtmpUrl,
      streamKey: ingressResult.ingress.streamKey,
    });
  } catch (error) {
    logger.error('Error generating RTMP key:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error generating stream key',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Delete a room (room manager only)
 * DELETE /api/rooms/:id
 */
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await Room.findById(id);

    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (!(await sendForbiddenUnlessRoomManager(room, userId, res, 'Only a room manager can delete the room'))) {
      return;
    }

    // Cannot delete a live room
    if (room.status === RoomStatus.LIVE) {
      return res.status(400).json({ message: 'Cannot delete a live room. End it first.' });
    }

    await Room.findByIdAndDelete(id);

    logger.info(`Room deleted: ${id} by ${userId}`);

    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting room:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error deleting room',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Archive/Unarchive a room (room manager only)
 * PATCH /api/rooms/:id/archive
 */
router.patch('/:id/archive', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await Room.findById(id);

    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (!(await sendForbiddenUnlessRoomManager(room, userId, res, 'Only a room manager can archive the room'))) {
      return;
    }

    // Cannot archive a live room
    if (room.status === RoomStatus.LIVE) {
      return res.status(400).json({ message: 'Cannot archive a live room. End it first.' });
    }

    // Toggle archived status
    room.archived = !room.archived;
    await room.save();

    logger.info(`Room ${room.archived ? 'archived' : 'unarchived'}: ${id} by ${userId}`);

    res.json({ success: true, archived: room.archived });
  } catch (error) {
    logger.error('Error archiving room:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error archiving room',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ---------------------------------------------------------------------------
// Recording endpoints (room-scoped)
// ---------------------------------------------------------------------------

/**
 * Start recording a live room (room manager only)
 * POST /api/rooms/:id/recording/start
 */
router.post('/:id/recording/start', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await Room.findById(id);
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (!(await sendForbiddenUnlessRoomManager(room, userId, res, 'Only a room manager can start recording'))) {
      return;
    }

    if (room.status !== RoomStatus.LIVE) {
      return res.status(400).json({ message: 'Room must be live to start recording' });
    }

    if (room.recordingEgressId) {
      return res.status(400).json({ message: 'Recording is already active' });
    }

    const recording = await startRecordingForRoom(room);

    const io = global.io;
    if (io) {
      io.of('/rooms').to(`room:${id}`).emit('room:recording:started', {
        roomId: id,
        recordingId: String(recording._id),
        timestamp: new Date().toISOString(),
      });
    }

    logger.info(`Recording manually started for room ${id}`);

    res.json({
      message: 'Recording started',
      recording,
    });
  } catch (error) {
    logger.error('Error starting recording:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error starting recording',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Stop recording a live room (room manager only)
 * POST /api/rooms/:id/recording/stop
 */
router.post('/:id/recording/stop', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await Room.findById(id);
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (!(await sendForbiddenUnlessRoomManager(room, userId, res, 'Only a room manager can stop recording'))) {
      return;
    }

    if (!room.recordingEgressId) {
      return res.status(400).json({ message: 'No active recording' });
    }

    await stopRecordingForRoom(room, 'manual');
    await room.save();

    logger.info(`Recording manually stopped for room ${id}`);

    res.json({ message: 'Recording stopped' });
  } catch (error) {
    logger.error('Error stopping recording:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error stopping recording',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * List recordings for a room (access-filtered)
 * GET /api/rooms/:id/recordings
 */
router.get('/:id/recordings', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;
    const { limit = '20', cursor } = req.query;

    const room = await Room.findById(id).lean();
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    const canManage = userId
      ? await canManageRoom(room, userId)
      : false;

    const query: Record<string, unknown> = {
      roomId: id,
      status: RecordingStatus.READY,
    };

    // Non-managers can only see public recordings or ones they participated in.
    if (!canManage && userId) {
      query.$or = [
        { access: RecordingAccess.PUBLIC },
        { access: RecordingAccess.PARTICIPANTS, participantIds: userId },
      ];
    } else if (!userId) {
      query.access = RecordingAccess.PUBLIC;
    }

    if (cursor && typeof cursor === 'string') {
      query._id = { $lt: cursor };
    }

    const limitNum = Math.min(Math.max(parseInt(limit as string, 10) || 20, 1), 100);

    const recordings = await Recording.find(query)
      .sort({ createdAt: -1 })
      .limit(limitNum + 1)
      .lean();

    const hasMore = recordings.length > limitNum;
    const recordingsToReturn = hasMore ? recordings.slice(0, limitNum) : recordings;
    const nextCursor = hasMore && recordingsToReturn.length > 0
      ? recordingsToReturn[recordingsToReturn.length - 1]._id.toString()
      : undefined;

    res.json({
      recordings: recordingsToReturn,
      hasMore,
      nextCursor,
    });
  } catch (error) {
    logger.error('Error fetching recordings:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error fetching recordings',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ---------------------------------------------------------------------------
// Room image upload
// ---------------------------------------------------------------------------

/**
 * Upload room/stream image
 * POST /api/rooms/:id/image
 */
router.post('/:id/image', uploadMiddleware.single('file'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!req.file) return res.status(400).json({ message: 'No file provided' });

    const room = await Room.findById(id);
    if (!room) return res.status(404).json({ message: 'Room not found' });
    if (!(await sendForbiddenUnlessRoomManager(room, userId, res, 'Only a room manager can upload a room image'))) {
      return;
    }

    const { buffer, contentType } = await processImage(req.file.buffer, 'roomImage');
    const objectKey = getAgoraRoomImageKey(id as string);

    if (room.streamImage?.startsWith('https://cloud.mention.earth/')) {
      const oldKey = room.streamImage.replace('https://cloud.mention.earth/', '');
      deleteObject(oldKey).catch(() => {});
    }

    const cdnUrl = await uploadObject(objectKey, buffer, contentType, 'public-read');
    room.streamImage = cdnUrl;
    await room.save();

    res.json({ streamImage: cdnUrl });
  } catch (error) {
    logger.error('Error uploading room image:', { roomId: req.params.id, error });
    res.status(500).json({ message: 'Error uploading image', error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

export default router;
