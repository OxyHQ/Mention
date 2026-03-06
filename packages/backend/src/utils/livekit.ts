import {
  AccessToken, RoomServiceClient, TrackSource,
  IngressClient, IngressInput, IngressInfo,
  EgressClient, EncodedFileOutput, EncodedFileType,
} from 'livekit-server-sdk';
import { getS3UploadConfig } from './spaces';
import { logger } from './logger';

const LIVEKIT_URL = process.env.LIVEKIT_URL || '';
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || '';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || '';

function getLiveKitUrl(): string {
  // RoomServiceClient needs HTTP(S) URL, not WSS
  return LIVEKIT_URL.replace('wss://', 'https://').replace('ws://', 'http://');
}

let roomService: RoomServiceClient | null = null;

function getRoomService(): RoomServiceClient {
  if (!roomService) {
    roomService = new RoomServiceClient(getLiveKitUrl(), LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
  }
  return roomService;
}

let egressClient: EgressClient | null = null;

function getEgressClient(): EgressClient {
  if (!egressClient) {
    egressClient = new EgressClient(getLiveKitUrl(), LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
  }
  return egressClient;
}

let ingressClient: IngressClient | null = null;

function getIngressClient(): IngressClient {
  if (!ingressClient) {
    ingressClient = new IngressClient(getLiveKitUrl(), LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
  }
  return ingressClient;
}

// ---------------------------------------------------------------------------
// Room-based functions (new naming convention using `room_{id}`)
// ---------------------------------------------------------------------------

/**
 * Generate a LiveKit access token for a user joining a room.
 * - Hosts and speakers can publish audio (microphone)
 * - Listeners can only subscribe
 */
export async function generateRoomToken(
  roomId: string,
  userId: string,
  role: 'host' | 'speaker' | 'listener'
): Promise<string> {
  const canPublish = role !== 'listener';

  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: userId,
    ttl: '6h',
    metadata: JSON.stringify({ roomId, role }),
  });

  at.addGrant({
    roomJoin: true,
    room: `room_${roomId}`,
    canPublish,
    canSubscribe: true,
    canPublishData: true,
    canPublishSources: canPublish ? [TrackSource.MICROPHONE] : [],
  });

  return await at.toJwt();
}

/**
 * Generate a listen-only LiveKit token for broadcast rooms.
 * Non-host users always get subscribe-only access (no publish).
 * The host receives full publish permissions.
 */
export async function generateBroadcastToken(
  roomId: string,
  userId: string,
  isHost: boolean
): Promise<string> {
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: userId,
    ttl: '6h',
    metadata: JSON.stringify({ roomId, role: isHost ? 'host' : 'listener', broadcast: true }),
  });

  at.addGrant({
    roomJoin: true,
    room: `room_${roomId}`,
    canPublish: isHost,
    canSubscribe: true,
    canPublishData: isHost,
    canPublishSources: isHost ? [TrackSource.MICROPHONE] : [],
  });

  return await at.toJwt();
}

/**
 * Create a LiveKit room when a room goes live.
 */
export async function createLiveKitRoomForRoom(roomId: string, maxParticipants: number = 100) {
  try {
    const room = await getRoomService().createRoom({
      name: `room_${roomId}`,
      emptyTimeout: 5 * 60, // 5 minutes before auto-cleanup
      maxParticipants,
    });
    logger.info(`LiveKit room created: room_${roomId}`);
    return room;
  } catch (error) {
    logger.error(`Failed to create LiveKit room for room ${roomId}:`, error);
    throw error;
  }
}

/**
 * Delete a LiveKit room when a room ends.
 */
export async function deleteLiveKitRoomForRoom(roomId: string) {
  try {
    await getRoomService().deleteRoom(`room_${roomId}`);
    logger.info(`LiveKit room deleted: room_${roomId}`);
  } catch (error) {
    // Room may already be gone -- not critical
    logger.warn(`Failed to delete LiveKit room for room ${roomId}:`, error);
  }
}

/**
 * Update a participant's publish permissions in a LiveKit room (room-based).
 * Called when a speaker is approved or removed.
 */
export async function updateRoomParticipantPermissions(
  roomId: string,
  userId: string,
  canPublish: boolean
) {
  try {
    await getRoomService().updateParticipant(`room_${roomId}`, userId, undefined, {
      canPublish,
      canPublishSources: canPublish ? [TrackSource.MICROPHONE] : [],
      canSubscribe: true,
    });
    logger.debug(`Updated LiveKit permissions for ${userId} in room ${roomId}: canPublish=${canPublish}`);
  } catch (error) {
    // Participant may not be in the LiveKit room yet -- not critical
    logger.warn(`Failed to update LiveKit permissions for ${userId} in room ${roomId}:`, error);
  }
}

/**
 * Create a URL-type ingress for a room.
 */
export async function createRoomUrlIngress(
  roomId: string,
  url: string
): Promise<IngressInfo> {
  try {
    const ingress = await getIngressClient().createIngress(IngressInput.URL_INPUT, {
      roomName: `room_${roomId}`,
      participantIdentity: `stream_${roomId}`,
      participantName: 'Live Stream',
      url,
      enableTranscoding: true,
    });
    logger.info(`URL ingress created for room ${roomId}: ${ingress.ingressId}`);
    return ingress;
  } catch (error) {
    logger.error(`Failed to create URL ingress for room ${roomId}:`, error);
    throw error;
  }
}

/**
 * Create an RTMP-type ingress for a room.
 */
export async function createRoomRtmpIngress(roomId: string): Promise<IngressInfo> {
  try {
    const ingress = await getIngressClient().createIngress(IngressInput.RTMP_INPUT, {
      roomName: `room_${roomId}`,
      participantIdentity: `stream_${roomId}`,
      participantName: 'Live Stream',
      enableTranscoding: true,
    });
    logger.info(`RTMP ingress created for room ${roomId}: ${ingress.ingressId}`);
    return ingress;
  } catch (error) {
    logger.error(`Failed to create RTMP ingress for room ${roomId}:`, error);
    throw error;
  }
}

/**
 * List all ingresses for a given room (for diagnostics).
 */
export async function listRoomIngresses(roomId: string): Promise<IngressInfo[]> {
  try {
    return await getIngressClient().listIngress({ roomName: `room_${roomId}` });
  } catch (error) {
    logger.warn(`Failed to list ingresses for room ${roomId}:`, error);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Backward-compatible aliases (old `space_{id}` naming)
// These delegate to the legacy implementations so existing callers and the
// spaceSocket module continue to work without changes.
// ---------------------------------------------------------------------------

/**
 * Delete an active ingress by its ID.
 */
export async function deleteIngress(ingressId: string): Promise<void> {
  try {
    await getIngressClient().deleteIngress(ingressId);
    logger.info(`Ingress deleted: ${ingressId}`);
  } catch (error) {
    logger.warn(`Failed to delete ingress ${ingressId}:`, error);
  }
}

// ---------------------------------------------------------------------------
// Recording (Egress) functions
// ---------------------------------------------------------------------------

/**
 * Start a Room Composite Egress that records all room audio to an OGG file
 * on DigitalOcean Spaces. Returns the egressId.
 */
export async function startRoomRecording(
  roomId: string,
  objectKey: string
): Promise<string> {
  try {
    const s3Config = getS3UploadConfig(objectKey);

    const output: EncodedFileOutput = new EncodedFileOutput({
      fileType: EncodedFileType.OGG,
      filepath: objectKey,
      output: {
        case: 's3',
        value: s3Config,
      },
      disableManifest: true,
    });

    const info = await getEgressClient().startRoomCompositeEgress(
      `room_${roomId}`,
      { file: output },
      { audioOnly: true }
    );

    logger.info(`Recording started for room ${roomId}, egressId: ${info.egressId}`);
    return info.egressId;
  } catch (error) {
    logger.error(`Failed to start recording for room ${roomId}:`, error);
    throw error;
  }
}

/**
 * Stop an active room recording by egressId.
 */
export async function stopRoomRecording(egressId: string): Promise<void> {
  try {
    await getEgressClient().stopEgress(egressId);
    logger.info(`Recording stopped: egressId ${egressId}`);
  } catch (error) {
    logger.error(`Failed to stop recording (egressId: ${egressId}):`, error);
    throw error;
  }
}

export { getRoomService, getEgressClient };
