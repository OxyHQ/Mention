import { API_URL_SOCKET } from '@/config';
import { io, Socket } from 'socket.io-client';

// TypeScript interfaces
export interface RoomParticipant {
  userId: string;
  role: 'host' | 'speaker' | 'listener';
  isMuted: boolean;
  joinedAt: string;
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

type ParticipantsUpdateCallback = (data: ParticipantsUpdateData) => void;
type MuteUpdateCallback = (data: MuteUpdateData) => void;
type SpeakerRequestCallback = (data: SpeakerRequestData) => void;
type SimpleRoomCallback = (data: { roomId: string; timestamp?: string }) => void;

export class RoomSocketService {
  private socket: Socket | null = null;
  private _isConnected = false;

  get isConnected(): boolean {
    return this._isConnected;
  }

  connect(userId: string, token?: string): void {
    if (this.socket?.connected) return;

    const baseUrl = API_URL_SOCKET || 'ws://localhost:3000';

    this.socket = io(`${baseUrl}/rooms`, {
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
      console.warn('Room socket connect error:', err.message);
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

  joinRoom(
    roomId: string,
    callback?: (res: {
      success: boolean;
      participants?: RoomParticipant[];
      myRole?: string;
      error?: string;
    }) => void
  ): void {
    this.socket?.emit('room:join', { roomId }, callback);
  }

  leaveRoom(roomId: string): void {
    this.socket?.emit('room:leave', { roomId });
  }

  setMute(roomId: string, isMuted: boolean): void {
    this.socket?.emit('audio:mute', { roomId, isMuted });
  }

  requestToSpeak(roomId: string): void {
    this.socket?.emit('speaker:request', { roomId });
  }

  approveSpeaker(roomId: string, targetUserId: string): void {
    this.socket?.emit('speaker:approve', { roomId, targetUserId });
  }

  denySpeaker(roomId: string, targetUserId: string): void {
    this.socket?.emit('speaker:deny', { roomId, targetUserId });
  }

  removeSpeaker(roomId: string, targetUserId: string): void {
    this.socket?.emit('speaker:remove', { roomId, targetUserId });
  }

  // --- Listener registration methods (return unsubscribe fn) ---

  onParticipantsUpdate(cb: ParticipantsUpdateCallback): () => void {
    this.socket?.on('room:participants:update', cb);
    return () => { this.socket?.off('room:participants:update', cb); };
  }

  onParticipantMute(cb: MuteUpdateCallback): () => void {
    this.socket?.on('room:participant:mute', cb);
    return () => { this.socket?.off('room:participant:mute', cb); };
  }

  onSpeakerRequestReceived(cb: SpeakerRequestCallback): () => void {
    this.socket?.on('speaker:request:received', cb);
    return () => { this.socket?.off('speaker:request:received', cb); };
  }

  onSpeakerApproved(cb: SimpleRoomCallback): () => void {
    this.socket?.on('speaker:approved', cb);
    return () => { this.socket?.off('speaker:approved', cb); };
  }

  onSpeakerDenied(cb: SimpleRoomCallback): () => void {
    this.socket?.on('speaker:denied', cb);
    return () => { this.socket?.off('speaker:denied', cb); };
  }

  onSpeakerRemoved(cb: SimpleRoomCallback): () => void {
    this.socket?.on('speaker:removed', cb);
    return () => { this.socket?.off('speaker:removed', cb); };
  }

  onRoomStarted(cb: SimpleRoomCallback): () => void {
    this.socket?.on('room:started', cb);
    return () => { this.socket?.off('room:started', cb); };
  }

  onRoomEnded(cb: SimpleRoomCallback): () => void {
    this.socket?.on('room:ended', cb);
    return () => { this.socket?.off('room:ended', cb); };
  }

  onUserJoined(cb: (data: { userId: string; role: string; roomId: string }) => void): () => void {
    this.socket?.on('room:user:joined', cb);
    return () => { this.socket?.off('room:user:joined', cb); };
  }

  onUserLeft(cb: (data: { userId: string; roomId: string }) => void): () => void {
    this.socket?.on('room:user:left', cb);
    return () => { this.socket?.off('room:user:left', cb); };
  }

  onStreamStarted(cb: (data: { roomId: string; title?: string; image?: string; description?: string; timestamp: string }) => void): () => void {
    this.socket?.on('room:stream:started', cb);
    return () => { this.socket?.off('room:stream:started', cb); };
  }

  onStreamStopped(cb: (data: { roomId: string; timestamp: string }) => void): () => void {
    this.socket?.on('room:stream:stopped', cb);
    return () => { this.socket?.off('room:stream:stopped', cb); };
  }
}

export const roomSocketService = new RoomSocketService();
export default roomSocketService;
