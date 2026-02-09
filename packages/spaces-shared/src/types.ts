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
  createdAt?: string;
  [key: string]: any;
}

export interface SpacesTheme {
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
  [key: string]: any;
}
