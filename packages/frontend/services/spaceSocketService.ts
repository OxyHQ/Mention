import { API_URL_SOCKET } from '@/config';
import { io, Socket } from 'socket.io-client';

// TypeScript interfaces
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

export interface AudioDataPayload {
  userId: string;
  chunk: string; // base64
  sequence: number;
  timestamp: number;
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

type ParticipantsUpdateCallback = (data: ParticipantsUpdateData) => void;
type AudioDataCallback = (data: AudioDataPayload) => void;
type MuteUpdateCallback = (data: MuteUpdateData) => void;
type SpeakerRequestCallback = (data: SpeakerRequestData) => void;
type SimpleSpaceCallback = (data: { spaceId: string; timestamp?: string }) => void;

class SpaceSocketService {
  private socket: Socket | null = null;
  private _isConnected = false;

  get isConnected(): boolean {
    return this._isConnected;
  }

  connect(userId: string, token?: string): void {
    if (this.socket?.connected) return;

    const baseUrl = API_URL_SOCKET || 'ws://localhost:3000';

    this.socket = io(`${baseUrl}/spaces`, {
      transports: ['websocket', 'polling'],
      auth: token ? { token, userId } : { userId },
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    });

    this.socket.on('connect', () => {
      this._isConnected = true;
    });

    this.socket.on('disconnect', () => {
      this._isConnected = false;
    });

    this.socket.on('connect_error', (err) => {
      console.warn('Space socket connect error:', err.message);
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
      this._isConnected = false;
    }
  }

  // --- Emit methods ---

  joinSpace(
    spaceId: string,
    callback?: (res: {
      success: boolean;
      participants?: SpaceParticipant[];
      myRole?: string;
      error?: string;
    }) => void
  ): void {
    this.socket?.emit('space:join', { spaceId }, callback);
  }

  leaveSpace(spaceId: string): void {
    this.socket?.emit('space:leave', { spaceId });
  }

  sendAudioData(spaceId: string, chunk: string, sequence: number): void {
    this.socket?.volatile.emit('audio:data', { spaceId, chunk, sequence });
  }

  setMute(spaceId: string, isMuted: boolean): void {
    this.socket?.emit('audio:mute', { spaceId, isMuted });
  }

  requestToSpeak(spaceId: string): void {
    this.socket?.emit('speaker:request', { spaceId });
  }

  approveSpeaker(spaceId: string, targetUserId: string): void {
    this.socket?.emit('speaker:approve', { spaceId, targetUserId });
  }

  denySpeaker(spaceId: string, targetUserId: string): void {
    this.socket?.emit('speaker:deny', { spaceId, targetUserId });
  }

  removeSpeaker(spaceId: string, targetUserId: string): void {
    this.socket?.emit('speaker:remove', { spaceId, targetUserId });
  }

  // --- Listener registration methods (return unsubscribe fn) ---

  onParticipantsUpdate(cb: ParticipantsUpdateCallback): () => void {
    this.socket?.on('space:participants:update', cb);
    return () => { this.socket?.off('space:participants:update', cb); };
  }

  onAudioData(cb: AudioDataCallback): () => void {
    this.socket?.on('audio:data', cb);
    return () => { this.socket?.off('audio:data', cb); };
  }

  onParticipantMute(cb: MuteUpdateCallback): () => void {
    this.socket?.on('space:participant:mute', cb);
    return () => { this.socket?.off('space:participant:mute', cb); };
  }

  onSpeakerRequestReceived(cb: SpeakerRequestCallback): () => void {
    this.socket?.on('speaker:request:received', cb);
    return () => { this.socket?.off('speaker:request:received', cb); };
  }

  onSpeakerApproved(cb: SimpleSpaceCallback): () => void {
    this.socket?.on('speaker:approved', cb);
    return () => { this.socket?.off('speaker:approved', cb); };
  }

  onSpeakerDenied(cb: SimpleSpaceCallback): () => void {
    this.socket?.on('speaker:denied', cb);
    return () => { this.socket?.off('speaker:denied', cb); };
  }

  onSpeakerRemoved(cb: SimpleSpaceCallback): () => void {
    this.socket?.on('speaker:removed', cb);
    return () => { this.socket?.off('speaker:removed', cb); };
  }

  onSpaceStarted(cb: SimpleSpaceCallback): () => void {
    this.socket?.on('space:started', cb);
    return () => { this.socket?.off('space:started', cb); };
  }

  onSpaceEnded(cb: SimpleSpaceCallback): () => void {
    this.socket?.on('space:ended', cb);
    return () => { this.socket?.off('space:ended', cb); };
  }

  onUserJoined(cb: (data: { userId: string; role: string; spaceId: string }) => void): () => void {
    this.socket?.on('space:user:joined', cb);
    return () => { this.socket?.off('space:user:joined', cb); };
  }

  onUserLeft(cb: (data: { userId: string; spaceId: string }) => void): () => void {
    this.socket?.on('space:user:left', cb);
    return () => { this.socket?.off('space:user:left', cb); };
  }
}

export const spaceSocketService = new SpaceSocketService();
export default spaceSocketService;
