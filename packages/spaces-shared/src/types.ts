export interface Space {
  _id: string;
  id?: string;
  title: string;
  description?: string;
  host: string;
  status: 'scheduled' | 'live' | 'ended';
  participants: string[];
  speakers: string[];
  maxParticipants: number;
  scheduledStart?: string;
  startedAt?: string;
  endedAt?: string;
  topic?: string;
  tags?: string[];
  speakerPermission?: 'everyone' | 'followers' | 'invited';
  stats?: { peakListeners: number; totalJoined: number };
  activeIngressId?: string;
  activeStreamUrl?: string;
  streamTitle?: string;
  streamImage?: string;
  streamDescription?: string;
  rtmpUrl?: string;
  rtmpStreamKey?: string;
  createdAt: string;
}

export interface SpaceParticipant {
  userId: string;
  role: 'host' | 'speaker' | 'listener';
  isMuted: boolean;
  joinedAt: string;
}

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

export interface StreamInfo {
  title?: string;
  image?: string;
  description?: string;
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
