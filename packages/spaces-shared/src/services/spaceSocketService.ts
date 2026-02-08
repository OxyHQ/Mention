import { io, Socket } from 'socket.io-client';
import type { SpaceParticipant, ParticipantsUpdateData, MuteUpdateData, SpeakerRequestData } from '../types';

type SimpleSpaceCallback = (data: { spaceId: string; timestamp?: string }) => void;

export class SpaceSocketService {
  private socket: Socket | null = null;
  private _isConnected = false;
  private socketUrl: string;

  constructor(socketUrl: string) {
    this.socketUrl = socketUrl;
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  connect(userId: string, token?: string): void {
    if (this.socket?.connected) return;

    const baseUrl = this.socketUrl || 'ws://localhost:3000';

    this.socket = io(`${baseUrl}/spaces`, {
      transports: ['websocket', 'polling'],
      auth: token ? { token, userId } : { userId },
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    });

    this.socket.on('connect', () => { this._isConnected = true; });
    this.socket.on('disconnect', () => { this._isConnected = false; });
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

  joinSpace(spaceId: string, callback?: (res: { success: boolean; participants?: SpaceParticipant[]; myRole?: string; error?: string }) => void): void {
    this.socket?.emit('space:join', { spaceId }, callback);
  }

  leaveSpace(spaceId: string): void { this.socket?.emit('space:leave', { spaceId }); }
  setMute(spaceId: string, isMuted: boolean): void { this.socket?.emit('audio:mute', { spaceId, isMuted }); }
  requestToSpeak(spaceId: string): void { this.socket?.emit('speaker:request', { spaceId }); }
  approveSpeaker(spaceId: string, targetUserId: string): void { this.socket?.emit('speaker:approve', { spaceId, targetUserId }); }
  denySpeaker(spaceId: string, targetUserId: string): void { this.socket?.emit('speaker:deny', { spaceId, targetUserId }); }
  removeSpeaker(spaceId: string, targetUserId: string): void { this.socket?.emit('speaker:remove', { spaceId, targetUserId }); }

  onParticipantsUpdate(cb: (data: ParticipantsUpdateData) => void): () => void {
    this.socket?.on('space:participants:update', cb);
    return () => { this.socket?.off('space:participants:update', cb); };
  }

  onParticipantMute(cb: (data: MuteUpdateData) => void): () => void {
    this.socket?.on('space:participant:mute', cb);
    return () => { this.socket?.off('space:participant:mute', cb); };
  }

  onSpeakerRequestReceived(cb: (data: SpeakerRequestData) => void): () => void {
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

  onStreamStarted(cb: (data: { spaceId: string; title?: string; image?: string; description?: string; timestamp: string }) => void): () => void {
    this.socket?.on('space:stream:started', cb);
    return () => { this.socket?.off('space:stream:started', cb); };
  }

  onStreamStopped(cb: (data: { spaceId: string; timestamp: string }) => void): () => void {
    this.socket?.on('space:stream:stopped', cb);
    return () => { this.socket?.off('space:stream:stopped', cb); };
  }
}
