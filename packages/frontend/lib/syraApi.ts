import type { LinkedHttpClient } from '@oxyhq/core';
import { oxyServices } from '@/lib/oxyServices';
import { SYRA_API_URL } from '@/config';
import { createLogger } from '@oxyhq/core/logger';

/** Lightweight authenticated Syra HTTP client; no LiveKit or UI imports. */
export const syraLinkedClient: LinkedHttpClient['client'] =
  oxyServices.createLinkedClient({
    baseURL: SYRA_API_URL,
  }).client;

const logger = createLogger('SyraApi');

export interface Room {
  _id: string;
  id?: string;
  title: string;
  description?: string | null;
  ownerType?: 'profile' | 'house' | 'agora';
  host: string;
  type: 'talk' | 'stage' | 'broadcast';
  status: 'scheduled' | 'live' | 'ended';
  scheduledStart?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  speakerPermission?: 'everyone' | 'followers' | 'invited' | null;
  participants: string[];
  speakers: string[];
  maxParticipants?: number;
  topic?: string | null;
  stats?: {
    peakListeners: number;
    totalJoined: number;
  };
  createdAt?: string;
}

export interface LiveUserEntry {
  userId: string;
  roomId: string;
}

export type LiveVisibility = 'active' | 'speaking';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : undefined;
}

function parseRoom(value: unknown): Room | null {
  const room = asRecord(value);
  if (
    !room ||
    typeof room._id !== 'string' ||
    typeof room.title !== 'string' ||
    typeof room.host !== 'string' ||
    (room.status !== 'scheduled' &&
      room.status !== 'live' &&
      room.status !== 'ended')
  ) {
    return null;
  }

  return {
    ...(room as unknown as Room),
    type:
      room.type === 'stage' || room.type === 'broadcast' ? room.type : 'talk',
    participants: Array.isArray(room.participants)
      ? room.participants.filter((id): id is string => typeof id === 'string')
      : [],
    speakers: Array.isArray(room.speakers)
      ? room.speakers.filter((id): id is string => typeof id === 'string')
      : [],
  };
}

async function getRooms(status?: string): Promise<Room[]> {
  try {
    const response = await syraLinkedClient.get<unknown>('/rooms', {
      params: status ? { status } : undefined,
    });
    const envelope = asRecord(response);
    const raw = envelope?.rooms ?? envelope?.data ?? response;
    return Array.isArray(raw)
      ? raw.map(parseRoom).filter((room): room is Room => room !== null)
      : [];
  } catch (error) {
    logger.warn('Failed to fetch live rooms', { error });
    return [];
  }
}

async function getRoom(id: string): Promise<Room | null> {
  if (!id) return null;
  try {
    const response = await syraLinkedClient.get<unknown>(`/rooms/${id}`);
    const envelope = asRecord(response);
    return parseRoom(envelope?.room ?? envelope?.data ?? response);
  } catch (error) {
    logger.warn('Failed to fetch live room', { error });
    return null;
  }
}

async function runRoomCommand(
  id: string,
  command: 'start' | 'end' | 'leave',
): Promise<boolean> {
  if (!id) return false;
  try {
    await syraLinkedClient.post(`/rooms/${id}/${command}`);
    return true;
  } catch (error) {
    logger.warn('Live room command failed', { command, error });
    return false;
  }
}

export const roomsService = {
  getRooms,
  getRoom,
  startRoom: (id: string) => runRoomCommand(id, 'start'),
  endRoom: (id: string) => runRoomCommand(id, 'end'),
  leaveRoom: (id: string) => runRoomCommand(id, 'leave'),
};

export async function getLiveRooms(status = 'live'): Promise<Room[]> {
  return getRooms(status);
}

export async function getLiveUsers(): Promise<LiveUserEntry[]> {
  const data = await syraLinkedClient.get<{ liveUsers?: LiveUserEntry[] }>(
    '/rooms/live-users',
  );
  return Array.isArray(data.liveUsers) ? data.liveUsers : [];
}

export async function getLivePresencePreference(): Promise<LiveVisibility> {
  const data = await syraLinkedClient.get<{ liveVisibility: LiveVisibility }>(
    '/rooms/me/presence-preference',
  );
  return data.liveVisibility;
}

export async function updateLivePresencePreference(
  liveVisibility: LiveVisibility,
): Promise<LiveVisibility> {
  const data = await syraLinkedClient.put<{ liveVisibility?: LiveVisibility }>(
    '/rooms/me/presence-preference',
    { liveVisibility },
  );
  return data.liveVisibility ?? liveVisibility;
}
