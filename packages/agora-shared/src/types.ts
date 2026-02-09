import type { RoomParticipant } from './validation';

// Re-export new primary types
export type {
  Room,
  RoomParticipant,
  StreamInfo,
  House,
  HouseMember,
  Series,
  SeriesEpisode,
  Recurrence,
  RoomTemplate,
  RoomAttachment,
} from './validation';

// Backward compat aliases
export type { Space, SpaceParticipant } from './validation';

export interface ParticipantsUpdateData {
  roomId: string;
  /** @deprecated use roomId */
  spaceId?: string;
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
  /** @deprecated use roomId */
  spaceId?: string;
  userId: string;
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

/** @deprecated use RoomAttachmentData */
export type SpaceAttachmentData = RoomAttachmentData;

export interface UserEntity {
  id: string;
  username?: string;
  name?: { full?: string; first?: string; last?: string } | string;
  handle?: string;
  avatar?: string;
  verified?: boolean;
  bio?: string;
  displayName?: string;
  createdAt?: string;
  [key: string]: unknown;
}

export interface SpacesTheme {
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
  post: (url: string, data?: Record<string, unknown>, config?: HttpRequestConfig) => Promise<HttpResponse>;
  patch: (url: string, data?: Record<string, unknown>, config?: HttpRequestConfig) => Promise<HttpResponse>;
  delete: (url: string, config?: HttpRequestConfig) => Promise<HttpResponse>;
}

export interface FileDownloadService {
  getFileDownloadUrl?(fileId: string, variant?: string, expiresIn?: number): string;
  getFileDownloadUrlAsync?(fileId: string, variant?: string, expiresIn?: number): Promise<string>;
}
