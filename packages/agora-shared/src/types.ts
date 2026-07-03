import type { RoomParticipant } from './validation';

export type {
  Room,
  RoomParticipant,
  Recording,
  House,
  HouseMember,
  Series,
  SeriesEpisode,
  Recurrence,
  RoomTemplate,
  RoomAttachment,
} from './validation';

/**
 * The "now playing" stream surfaced in the live room. Derived from the
 * `room:stream:started` socket payload (and the room's persisted stream fields);
 * it is NOT parsed through zod, so it stays a plain structural type rather than
 * `z.infer<typeof ZStreamInfo>`. `startedAt` / `durationSec` are present for
 * length-known streams (e.g. a podcast episode) and drive the progress bar;
 * manual URL/RTMP streams omit them and render no progress UI.
 */
export interface StreamInfo {
  title?: string;
  image?: string;
  description?: string;
  /** ISO timestamp when the current stream began. */
  startedAt?: string;
  /** Total length of the current stream in seconds, when known. */
  durationSec?: number;
}

export interface ParticipantsUpdateData {
  roomId: string;
  participants: RoomParticipant[];
  count: number;
  timestamp: string;
}

export interface MuteUpdateData {
  userId: string;
  isMuted: boolean;
  timestamp: string;
}

export interface SpeakerRequestData {
  roomId: string;
  userId: string;
  timestamp: string;
}

export interface RecordingStateData {
  roomId: string;
  recordingId: string;
  reason?: 'manual' | 'max_duration' | 'room_ended' | 'room_stopped';
  timestamp: string;
}

export interface RoomAttachmentData {
  roomId: string;
  title: string;
  status?: 'scheduled' | 'live' | 'ended';
  type?: 'talk' | 'stage' | 'broadcast';
  topic?: string;
  host?: string;
}

export interface UserEntity {
  id: string;
  username?: string;
  name?: { displayName?: string; full?: string; first?: string; last?: string } | string;
  handle?: string;
  // Adapts the Oxy SDK `User.avatar` (`string | null`): the API projects avatar
  // from a nullable column, so `null` is a legitimate value at this boundary.
  avatar?: string | null;
  verified?: boolean;
  bio?: string;
  displayName?: string;
  createdAt?: string;
  [key: string]: unknown;
}

export interface AgoraTheme {
  isDark?: boolean;
  colors: {
    text: string;
    textSecondary: string;
    background: string;
    backgroundSecondary: string;
    card: string;
    border: string;
    primary: string;
    [key: string]: string;
  };
}

export interface HttpResponse {
  data: Record<string, unknown>;
}

export interface HttpRequestConfig {
  params?: Record<string, string | number | boolean | undefined>;
  [key: string]: unknown;
}

export interface HttpClient {
  get: (url: string, config?: HttpRequestConfig) => Promise<HttpResponse>;
  post: (url: string, data?: Record<string, unknown> | FormData, config?: HttpRequestConfig) => Promise<HttpResponse>;
  patch: (url: string, data?: Record<string, unknown>, config?: HttpRequestConfig) => Promise<HttpResponse>;
  delete: (url: string, config?: HttpRequestConfig) => Promise<HttpResponse>;
}

export interface FileDownloadService {
  getFileDownloadUrl?(fileId: string, variant?: string, expiresIn?: number): string;
  getFileDownloadUrlAsync?(fileId: string, variant?: string, expiresIn?: number): Promise<string>;
}
