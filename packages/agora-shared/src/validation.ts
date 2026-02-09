import { z } from 'zod';

// --- Room (replaces Space) ---

export const ZRoom = z.object({
  _id: z.string(),
  id: z.string().optional(),
  title: z.string(),
  description: z.string().optional(),

  // Ownership
  ownerType: z.enum(['profile', 'house', 'agora']).default('profile'),
  host: z.string(),
  houseId: z.string().optional().nullable(),
  createdByAdmin: z.string().optional().nullable(),

  // Classification
  type: z.enum(['talk', 'stage', 'broadcast']).default('talk'),
  broadcastKind: z.enum(['user', 'agora']).optional().nullable(),

  // Lifecycle
  status: z.enum(['scheduled', 'live', 'ended']),
  scheduledStart: z.string().optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),

  // Participation
  speakerPermission: z.enum(['everyone', 'followers', 'invited']).optional(),
  participants: z.array(z.string()).default([]),
  speakers: z.array(z.string()).default([]),
  maxParticipants: z.number().default(100),

  // Content
  topic: z.string().optional(),
  tags: z.array(z.string()).optional(),
  archived: z.boolean().optional().default(false),
  seriesId: z.string().optional().nullable(),

  // Stats
  stats: z.object({
    peakListeners: z.number(),
    totalJoined: z.number(),
  }).optional(),

  // Streaming
  activeIngressId: z.string().optional(),
  activeStreamUrl: z.string().optional(),
  streamTitle: z.string().optional(),
  streamImage: z.string().optional(),
  streamDescription: z.string().optional(),
  rtmpUrl: z.string().optional(),
  rtmpStreamKey: z.string().optional(),

  createdAt: z.string(),
}).passthrough();

export type Room = z.infer<typeof ZRoom>;

// --- Room Participant ---

export const ZRoomParticipant = z.object({
  userId: z.string(),
  role: z.enum(['host', 'speaker', 'listener']),
  isMuted: z.boolean(),
  joinedAt: z.string(),
}).passthrough();

export type RoomParticipant = z.infer<typeof ZRoomParticipant>;

// --- House ---

export const ZHouseMember = z.object({
  userId: z.string(),
  role: z.enum(['owner', 'admin', 'host', 'member']),
  joinedAt: z.string(),
}).passthrough();

export type HouseMember = z.infer<typeof ZHouseMember>;

export const ZHouse = z.object({
  _id: z.string(),
  id: z.string().optional(),
  name: z.string(),
  description: z.string().optional(),
  avatar: z.string().optional().nullable(),
  coverImage: z.string().optional().nullable(),
  members: z.array(ZHouseMember).default([]),
  createdBy: z.string(),
  isPublic: z.boolean().default(true),
  tags: z.array(z.string()).optional(),
  createdAt: z.string(),
}).passthrough();

export type House = z.infer<typeof ZHouse>;

// --- Series ---

export const ZRecurrence = z.object({
  type: z.enum(['daily', 'weekly', 'biweekly', 'monthly']),
  dayOfWeek: z.number().min(0).max(6).optional(),
  dayOfMonth: z.number().min(1).max(31).optional(),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  timezone: z.string().default('UTC'),
}).passthrough();

export type Recurrence = z.infer<typeof ZRecurrence>;

export const ZRoomTemplate = z.object({
  titlePattern: z.string(),
  type: z.enum(['talk', 'stage', 'broadcast']).default('talk'),
  description: z.string().optional(),
  maxParticipants: z.number().default(100),
  speakerPermission: z.enum(['everyone', 'followers', 'invited']).default('invited'),
  tags: z.array(z.string()).optional(),
}).passthrough();

export type RoomTemplate = z.infer<typeof ZRoomTemplate>;

export const ZSeriesEpisode = z.object({
  roomId: z.string(),
  scheduledStart: z.string(),
  episodeNumber: z.number(),
}).passthrough();

export type SeriesEpisode = z.infer<typeof ZSeriesEpisode>;

export const ZSeries = z.object({
  _id: z.string(),
  id: z.string().optional(),
  title: z.string(),
  description: z.string().optional(),
  coverImage: z.string().optional().nullable(),
  houseId: z.string().optional().nullable(),
  createdBy: z.string(),
  recurrence: ZRecurrence,
  roomTemplate: ZRoomTemplate,
  episodes: z.array(ZSeriesEpisode).default([]),
  nextEpisodeNumber: z.number().default(1),
  isActive: z.boolean().default(true),
  createdAt: z.string(),
}).passthrough();

export type Series = z.infer<typeof ZSeries>;

// --- Stream responses ---

export const ZStartStreamResponse = z.object({
  ingressId: z.string(),
  url: z.string(),
}).passthrough();

export const ZGenerateStreamKeyResponse = z.object({
  rtmpUrl: z.string(),
  streamKey: z.string(),
}).passthrough();

export const ZStreamInfo = z.object({
  title: z.string().optional(),
  image: z.string().optional(),
  description: z.string().optional(),
}).passthrough();

export type StreamInfo = z.infer<typeof ZStreamInfo>;

// --- Room attachment for posts ---

export const ZRoomAttachment = z.object({
  roomId: z.string(),
  title: z.string(),
  status: z.enum(['scheduled', 'live', 'ended']).optional(),
  type: z.enum(['talk', 'stage', 'broadcast']).optional(),
  topic: z.string().optional(),
  host: z.string().optional(),
}).passthrough();

export type RoomAttachment = z.infer<typeof ZRoomAttachment>;

// --- Validators ---

export function validateRoom(data: unknown): Room | null {
  const result = ZRoom.safeParse(data);
  if (result.success) return result.data;
  console.warn('[agora-shared] Invalid Room:', result.error.issues[0]);
  return null;
}

export function validateRooms(items: unknown[]): Room[] {
  if (!Array.isArray(items)) return [];
  const valid: Room[] = [];
  for (const item of items) {
    const parsed = ZRoom.safeParse(item);
    if (parsed.success) {
      valid.push(parsed.data);
    } else {
      console.warn('[agora-shared] Dropping invalid room:', parsed.error.issues[0]);
    }
  }
  return valid;
}

export function validateHouse(data: unknown): House | null {
  const result = ZHouse.safeParse(data);
  if (result.success) return result.data;
  console.warn('[agora-shared] Invalid House:', result.error.issues[0]);
  return null;
}

export function validateSeries(data: unknown): Series | null {
  const result = ZSeries.safeParse(data);
  if (result.success) return result.data;
  console.warn('[agora-shared] Invalid Series:', result.error.issues[0]);
  return null;
}

