import { z } from 'zod';

export const ZSpace = z.object({
  _id: z.string(),
  id: z.string().optional(),
  title: z.string(),
  description: z.string().optional(),
  host: z.string(),
  status: z.enum(['scheduled', 'live', 'ended']),
  participants: z.array(z.string()).default([]),
  speakers: z.array(z.string()).default([]),
  maxParticipants: z.number().default(100),
  scheduledStart: z.string().optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  topic: z.string().optional(),
  tags: z.array(z.string()).optional(),
  speakerPermission: z.enum(['everyone', 'followers', 'invited']).optional(),
  stats: z.object({
    peakListeners: z.number(),
    totalJoined: z.number(),
  }).optional(),
  activeIngressId: z.string().optional(),
  activeStreamUrl: z.string().optional(),
  streamTitle: z.string().optional(),
  streamImage: z.string().optional(),
  streamDescription: z.string().optional(),
  rtmpUrl: z.string().optional(),
  rtmpStreamKey: z.string().optional(),
  createdAt: z.string(),
}).passthrough();

export type Space = z.infer<typeof ZSpace>;

export const ZSpaceParticipant = z.object({
  userId: z.string(),
  role: z.enum(['host', 'speaker', 'listener']),
  isMuted: z.boolean(),
  joinedAt: z.string(),
}).passthrough();

export type SpaceParticipant = z.infer<typeof ZSpaceParticipant>;

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

export function validateSpace(data: unknown): Space | null {
  const result = ZSpace.safeParse(data);
  if (result.success) return result.data;
  console.warn('[spaces-shared] Invalid Space:', result.error.issues[0]);
  return null;
}

export function validateSpaces(items: unknown[]): Space[] {
  if (!Array.isArray(items)) return [];
  const valid: Space[] = [];
  for (const item of items) {
    const parsed = ZSpace.safeParse(item);
    if (parsed.success) {
      valid.push(parsed.data);
    } else {
      console.warn('[spaces-shared] Dropping invalid space:', parsed.error.issues[0]);
    }
  }
  return valid;
}
