import express from 'express';
import request from 'supertest';
import type { IncomingMessage } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedPodcastEpisode } from '../../utils/syraPodcast';

/**
 * Route-level coverage for `POST /rooms/:id/stream/podcast` and its
 * `/podcast/next` sibling. Exercises the REAL handlers (and the shared
 * `startPodcastEpisodeStream` / `advancePodcastQueueForRoom` helpers) against
 * mocked LiveKit + Syra + SSRF-fetch + Room-model boundaries, asserting the
 * manager gate, the live gate, the tri-state resolve mapping (not_found → 404,
 * unavailable → 503), the SSRF audio-URL probe (non-audio → 400, unreachable →
 * 502), the queue persistence, and the manual advance / queue-drain behavior.
 */

const TEST_USER = 'host-1';

// LiveKit ingress boundary — the helper's only external I/O on the happy path.
vi.mock('../../utils/livekit', () => ({
  generateRoomToken: vi.fn(),
  generateBroadcastToken: vi.fn(),
  createLiveKitRoomForRoom: vi.fn(),
  ensureLiveKitRoomForRoom: vi.fn().mockResolvedValue(undefined),
  deleteLiveKitRoomForRoom: vi.fn(),
  createRoomUrlIngress: vi.fn().mockResolvedValue({ ingressId: 'ingress-xyz', url: '' }),
  createRoomRtmpIngress: vi.fn(),
  deleteIngress: vi.fn().mockResolvedValue(undefined),
  startRoomRecording: vi.fn(),
  stopRoomRecording: vi.fn(),
}));

vi.mock('../../utils/livekitErrors', () => ({
  mapLiveKitIngressError: vi.fn(() => ({
    statusCode: 502,
    message: 'LiveKit error',
    code: 'INGRESS_FAILED',
    liveKit: { status: 502, code: 'INGRESS_FAILED', message: 'LiveKit error' },
  })),
  shouldRetryIngressAfterDeletingExisting: vi.fn(() => false),
}));

// Syra episode resolution — the unit under mock control for each test case.
vi.mock('../../utils/syraPodcast', () => ({
  resolvePodcastEpisode: vi.fn(),
}));

// SSRF-safe pre-ingress probe — keep the real `contentTypeFamily` / `SsrfRejection`
// but stub the network fetch so no real DNS/HTTP happens.
vi.mock('../../utils/safeUpstreamFetch', async () => {
  const actual = await vi.importActual<typeof import('../../utils/safeUpstreamFetch')>(
    '../../utils/safeUpstreamFetch',
  );
  return {
    ...actual,
    fetchUpstreamFollowingRedirects: vi.fn(),
  };
});

// Room model: keep the real enums (RoomStatus/OwnerType/...) but replace the
// Mongoose model with a controllable findById.
vi.mock('../../models/Room', async () => {
  const actual = await vi.importActual<typeof import('../../models/Room')>('../../models/Room');
  return {
    ...actual,
    default: { findById: vi.fn() },
  };
});

// Unrelated boundaries pulled in by other routes in the same module — stub so
// the module imports cleanly without loading AWS / image / socket internals.
vi.mock('../../models/House', () => ({ default: { findById: vi.fn() }, HouseMemberRole: { ADMIN: 'admin' } }));
vi.mock('../../middleware/admin', () => ({ isAdmin: vi.fn(() => false) }));
vi.mock('../../models/Recording', () => ({ default: {}, RecordingStatus: {}, RecordingAccess: {} }));
vi.mock('../../utils/spaces', () => ({
  getRecordingObjectKey: vi.fn(),
  uploadObject: vi.fn(),
  deleteObject: vi.fn(),
  getAgoraRoomImageKey: vi.fn(),
}));
vi.mock('../../utils/imageProcessor', () => ({ processImage: vi.fn() }));
vi.mock('../../utils/socket', () => ({ emitLiveRoomsUpdated: vi.fn() }));

import Room, { RoomStatus, OwnerType } from '../../models/Room';
import { createRoomUrlIngress, ensureLiveKitRoomForRoom, deleteIngress } from '../../utils/livekit';
import { resolvePodcastEpisode } from '../../utils/syraPodcast';
import { fetchUpstreamFollowingRedirects } from '../../utils/safeUpstreamFetch';
import roomsRouter from '../../routes/rooms.routes';

const findById = vi.mocked(Room.findById);
const resolveEpisode = vi.mocked(resolvePodcastEpisode);
const createUrlIngress = vi.mocked(createRoomUrlIngress);
const ensureRoom = vi.mocked(ensureLiveKitRoomForRoom);
const deleteIngressMock = vi.mocked(deleteIngress);
const fetchUpstream = vi.mocked(fetchUpstreamFollowingRedirects);

/** A minimal Room document with a spyable `save`. Overrides win. */
function makeRoom(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'room-1',
    host: TEST_USER,
    ownerType: OwnerType.PROFILE,
    status: RoomStatus.LIVE,
    maxParticipants: 100,
    activeIngressId: undefined as string | undefined,
    activeStreamUrl: undefined as string | undefined,
    rtmpUrl: undefined as string | undefined,
    rtmpStreamKey: undefined as string | undefined,
    streamTitle: undefined as string | undefined,
    streamImage: undefined as string | undefined,
    streamDescription: undefined as string | undefined,
    streamStartedAt: undefined as Date | undefined,
    streamDurationSec: undefined as number | undefined,
    podcastQueue: undefined as { syraPodcastId?: string; episodeId: string }[] | undefined,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** Make the SSRF probe resolve with a chosen status + content-type. */
function mockAudioProbe(contentType: string, statusCode = 200) {
  fetchUpstream.mockResolvedValue({
    response: {
      statusCode,
      headers: { 'content-type': contentType },
      destroy: vi.fn(),
    } as unknown as IncomingMessage,
    finalUrl: 'https://api.fastcast.ai/audio/ep-1.mp3',
  });
}

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as express.Request & { user?: { id: string } }).user = { id: TEST_USER };
  next();
});
app.use('/rooms', roomsRouter);

const RESOLVED: ResolvedPodcastEpisode = {
  audioUrl: 'https://api.fastcast.ai/audio/ep-1.mp3',
  title: 'Episode One',
  artworkUrl: 'https://cdn.syra.fm/art/ep-1.jpg',
  durationSec: 120,
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: episodes resolve and their audio probes as valid audio.
  mockAudioProbe('audio/mpeg');
});

describe('POST /rooms/:id/stream/podcast', () => {
  it('rejects a non-manager with 403 and never resolves the episode', async () => {
    findById.mockResolvedValue(makeRoom({ host: 'someone-else' }));

    const res = await request(app)
      .post('/rooms/room-1/stream/podcast')
      .send({ syraPodcastId: 'show-1', episodeId: 'ep-1' });

    expect(res.status).toBe(403);
    expect(resolveEpisode).not.toHaveBeenCalled();
    expect(createUrlIngress).not.toHaveBeenCalled();
  });

  it('rejects with 400 when the room is not live', async () => {
    findById.mockResolvedValue(makeRoom({ status: RoomStatus.SCHEDULED }));

    const res = await request(app)
      .post('/rooms/room-1/stream/podcast')
      .send({ syraPodcastId: 'show-1', episodeId: 'ep-1' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Room must be live to add a stream');
    expect(resolveEpisode).not.toHaveBeenCalled();
  });

  it('rejects with 400 when episodeId is missing', async () => {
    const res = await request(app).post('/rooms/room-1/stream/podcast').send({ syraPodcastId: 'show-1' });

    expect(res.status).toBe(400);
    expect(findById).not.toHaveBeenCalled();
  });

  it('rejects with 400 when queue is malformed', async () => {
    findById.mockResolvedValue(makeRoom());

    const res = await request(app)
      .post('/rooms/room-1/stream/podcast')
      .send({ episodeId: 'ep-1', queue: [{ notAnEpisode: true }] });

    expect(res.status).toBe(400);
    expect(resolveEpisode).not.toHaveBeenCalled();
  });

  it('returns 404 when the episode cannot be resolved (not_found)', async () => {
    findById.mockResolvedValue(makeRoom());
    resolveEpisode.mockResolvedValue({ status: 'not_found' });

    const res = await request(app)
      .post('/rooms/room-1/stream/podcast')
      .send({ syraPodcastId: 'show-1', episodeId: 'missing' });

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Podcast episode not found');
    expect(resolveEpisode).toHaveBeenCalledWith('missing', 'show-1');
    expect(createUrlIngress).not.toHaveBeenCalled();
  });

  it('returns 503 when Syra is unavailable', async () => {
    findById.mockResolvedValue(makeRoom());
    resolveEpisode.mockResolvedValue({ status: 'unavailable' });

    const res = await request(app)
      .post('/rooms/room-1/stream/podcast')
      .send({ syraPodcastId: 'show-1', episodeId: 'ep-1' });

    expect(res.status).toBe(503);
    expect(fetchUpstream).not.toHaveBeenCalled();
    expect(createUrlIngress).not.toHaveBeenCalled();
  });

  it('returns 400 when the resolved audio URL is not audio', async () => {
    findById.mockResolvedValue(makeRoom());
    resolveEpisode.mockResolvedValue({ status: 'ok', episode: RESOLVED });
    mockAudioProbe('text/html');

    const res = await request(app)
      .post('/rooms/room-1/stream/podcast')
      .send({ syraPodcastId: 'show-1', episodeId: 'ep-1' });

    expect(res.status).toBe(400);
    expect(createUrlIngress).not.toHaveBeenCalled();
  });

  it('returns 502 when the resolved audio URL is unreachable', async () => {
    findById.mockResolvedValue(makeRoom());
    resolveEpisode.mockResolvedValue({ status: 'ok', episode: RESOLVED });
    fetchUpstream.mockRejectedValue(new Error('connection refused'));

    const res = await request(app)
      .post('/rooms/room-1/stream/podcast')
      .send({ syraPodcastId: 'show-1', episodeId: 'ep-1' });

    expect(res.status).toBe(502);
    expect(createUrlIngress).not.toHaveBeenCalled();
  });

  it('starts a URL ingress from the server-resolved episode audio + metadata', async () => {
    const room = makeRoom();
    findById.mockResolvedValue(room);
    resolveEpisode.mockResolvedValue({ status: 'ok', episode: RESOLVED });

    const res = await request(app)
      .post('/rooms/room-1/stream/podcast')
      .send({ syraPodcastId: 'show-1', episodeId: 'ep-1' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      message: 'Stream started successfully',
      ingressId: 'ingress-xyz',
      url: 'https://api.fastcast.ai/audio/ep-1.mp3',
    });

    expect(resolveEpisode).toHaveBeenCalledWith('ep-1', 'show-1');
    expect(ensureRoom).toHaveBeenCalledWith('room-1', 100);
    expect(createUrlIngress).toHaveBeenCalledWith('room-1', 'https://api.fastcast.ai/audio/ep-1.mp3');

    expect(room.save).toHaveBeenCalledTimes(1);
    expect(room.activeIngressId).toBe('ingress-xyz');
    expect(room.activeStreamUrl).toBe('https://api.fastcast.ai/audio/ep-1.mp3');
    expect(room.streamTitle).toBe('Episode One');
    expect(room.streamImage).toBe('https://cdn.syra.fm/art/ep-1.jpg');
    expect(room.streamDescription).toBeUndefined();
    expect(room.streamDurationSec).toBe(120);
    expect(room.streamStartedAt).toBeInstanceOf(Date);
    expect(room.rtmpUrl).toBeUndefined();
    expect(room.rtmpStreamKey).toBeUndefined();
  });

  it('persists the remaining queue when starting the first episode', async () => {
    const room = makeRoom();
    findById.mockResolvedValue(room);
    resolveEpisode.mockResolvedValue({ status: 'ok', episode: RESOLVED });

    const res = await request(app)
      .post('/rooms/room-1/stream/podcast')
      .send({
        syraPodcastId: 'show-1',
        episodeId: 'ep-1',
        queue: [{ syraPodcastId: 'show-1', episodeId: 'ep-2' }, { episodeId: 'ep-3' }],
      });

    expect(res.status).toBe(200);
    expect(room.podcastQueue).toEqual([
      { syraPodcastId: 'show-1', episodeId: 'ep-2' },
      { episodeId: 'ep-3' },
    ]);
  });
});

describe('POST /rooms/:id/stream/podcast/next', () => {
  it('advances to the next queued episode', async () => {
    const room = makeRoom({
      activeIngressId: 'ingress-old',
      podcastQueue: [{ syraPodcastId: 'show-1', episodeId: 'ep-2' }],
    });
    findById.mockResolvedValue(room);
    resolveEpisode.mockResolvedValue({
      status: 'ok',
      episode: { ...RESOLVED, audioUrl: 'https://api.fastcast.ai/audio/ep-2.mp3', title: 'Episode Two' },
    });

    const res = await request(app).post('/rooms/room-1/stream/podcast/next').send();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ message: 'Stream started successfully', ingressId: 'ingress-xyz' });
    expect(resolveEpisode).toHaveBeenCalledWith('ep-2', 'show-1');
    expect(createUrlIngress).toHaveBeenCalledWith('room-1', 'https://api.fastcast.ai/audio/ep-2.mp3');
    // Queue drained to empty ⇒ cleared to undefined.
    expect(room.podcastQueue).toBeUndefined();
  });

  it('stops the stream when the queue is empty', async () => {
    const room = makeRoom({ activeIngressId: 'ingress-old', podcastQueue: undefined });
    findById.mockResolvedValue(room);

    const res = await request(app).post('/rooms/room-1/stream/podcast/next').send();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Stream ended', ended: true });
    expect(deleteIngressMock).toHaveBeenCalledWith('ingress-old');
    expect(createUrlIngress).not.toHaveBeenCalled();
    expect(room.activeIngressId).toBeUndefined();
    expect(room.streamStartedAt).toBeUndefined();
    expect(room.save).toHaveBeenCalled();
  });

  it('rejects a non-manager with 403', async () => {
    findById.mockResolvedValue(makeRoom({ host: 'someone-else', podcastQueue: [{ episodeId: 'ep-2' }] }));

    const res = await request(app).post('/rooms/room-1/stream/podcast/next').send();

    expect(res.status).toBe(403);
    expect(resolveEpisode).not.toHaveBeenCalled();
  });
});
