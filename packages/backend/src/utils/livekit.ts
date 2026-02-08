import { AccessToken, RoomServiceClient, TrackSource, IngressClient, IngressInput, IngressInfo } from 'livekit-server-sdk';
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

let ingressClient: IngressClient | null = null;

function getIngressClient(): IngressClient {
  if (!ingressClient) {
    ingressClient = new IngressClient(getLiveKitUrl(), LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
  }
  return ingressClient;
}

/**
 * Generate a LiveKit access token for a user joining a space.
 * - Hosts and speakers can publish audio (microphone)
 * - Listeners can only subscribe
 */
export async function generateSpaceToken(
  spaceId: string,
  userId: string,
  role: 'host' | 'speaker' | 'listener'
): Promise<string> {
  const canPublish = role !== 'listener';

  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: userId,
    ttl: '6h',
    metadata: JSON.stringify({ spaceId, role }),
  });

  at.addGrant({
    roomJoin: true,
    room: `space_${spaceId}`,
    canPublish,
    canSubscribe: true,
    canPublishData: true,
    canPublishSources: canPublish ? [TrackSource.MICROPHONE] : [],
  });

  return await at.toJwt();
}

/**
 * Create a LiveKit room for a space when it goes live.
 */
export async function createLiveKitRoom(spaceId: string, maxParticipants: number = 100) {
  try {
    const room = await getRoomService().createRoom({
      name: `space_${spaceId}`,
      emptyTimeout: 5 * 60, // 5 minutes before auto-cleanup
      maxParticipants,
    });
    logger.info(`LiveKit room created: space_${spaceId}`);
    return room;
  } catch (error) {
    logger.error(`Failed to create LiveKit room for space ${spaceId}:`, error);
    throw error;
  }
}

/**
 * Delete a LiveKit room when a space ends.
 */
export async function deleteLiveKitRoom(spaceId: string) {
  try {
    await getRoomService().deleteRoom(`space_${spaceId}`);
    logger.info(`LiveKit room deleted: space_${spaceId}`);
  } catch (error) {
    // Room may already be gone — not critical
    logger.warn(`Failed to delete LiveKit room for space ${spaceId}:`, error);
  }
}

/**
 * Update a participant's publish permissions in a LiveKit room.
 * Called when a speaker is approved or removed.
 */
export async function updateParticipantPermissions(
  spaceId: string,
  userId: string,
  canPublish: boolean
) {
  try {
    await getRoomService().updateParticipant(`space_${spaceId}`, userId, undefined, {
      canPublish,
      canPublishSources: canPublish ? [TrackSource.MICROPHONE] : [],
      canSubscribe: true,
    });
    logger.debug(`Updated LiveKit permissions for ${userId} in space ${spaceId}: canPublish=${canPublish}`);
  } catch (error) {
    // Participant may not be in the LiveKit room yet — not critical
    logger.warn(`Failed to update LiveKit permissions for ${userId} in space ${spaceId}:`, error);
  }
}

/**
 * Create a URL-type ingress that pulls live audio from an external URL
 * and publishes it into the space's LiveKit room.
 */
export async function createUrlIngress(
  spaceId: string,
  url: string
): Promise<IngressInfo> {
  try {
    const ingress = await getIngressClient().createIngress(IngressInput.URL_INPUT, {
      roomName: `space_${spaceId}`,
      participantIdentity: `stream_${spaceId}`,
      participantName: 'Live Stream',
      url,
      enableTranscoding: true,
    });
    logger.info(`URL ingress created for space ${spaceId}: ${ingress.ingressId}`);
    return ingress;
  } catch (error) {
    logger.error(`Failed to create URL ingress for space ${spaceId}:`, error);
    throw error;
  }
}

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

/**
 * List all ingresses for a given space room (for diagnostics).
 */
export async function listSpaceIngresses(spaceId: string): Promise<IngressInfo[]> {
  try {
    return await getIngressClient().listIngress({ roomName: `space_${spaceId}` });
  } catch (error) {
    logger.warn(`Failed to list ingresses for space ${spaceId}:`, error);
    return [];
  }
}

export { getRoomService };
