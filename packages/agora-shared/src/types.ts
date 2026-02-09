import type { SpaceParticipant } from './validation';

export type { Space, SpaceParticipant, StreamInfo } from './validation';

export interface ParticipantsUpdateData {
  spaceId: string;
  participants: SpaceParticipant[];
  count: number;
  timestamp: string;
}

export interface MuteUpdateData {
  userId: string;
  isMuted: boolean;
  timestamp: string;
}

export interface SpeakerRequestData {
  spaceId: string;
  userId: string;
  timestamp: string;
}

export interface SpaceAttachmentData {
  spaceId: string;
  title: string;
  status?: 'scheduled' | 'live' | 'ended';
  topic?: string;
  host?: string;
}

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
