import { authenticatedClient } from "@/utils/api";

export interface Room {
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
  type?: 'talk' | 'stage' | 'broadcast';
  ownerType?: 'profile' | 'house' | 'agora';
  broadcastKind?: 'user' | 'agora';
  houseId?: string;
  seriesId?: string;
  createdAt: string;
}

class RoomsService {
  async getRooms(status?: string): Promise<Room[]> {
    try {
      const params: any = {};
      if (status) params.status = status;
      const res = await authenticatedClient.get("/rooms", { params });
      return res.data.rooms || res.data.data || res.data || [];
    } catch (error) {
      console.warn("Failed to fetch rooms", error);
      return [];
    }
  }

  async getRoom(id: string): Promise<Room | null> {
    if (!id) return null;
    try {
      const res = await authenticatedClient.get(`/rooms/${id}`);
      return res.data.room || res.data.data || res.data || null;
    } catch (error) {
      console.warn("Failed to fetch room", error);
      return null;
    }
  }

  async createRoom(data: { title: string; description?: string; topic?: string; scheduledStart?: string; speakerPermission?: 'everyone' | 'followers' | 'invited' }): Promise<Room | null> {
    try {
      const res = await authenticatedClient.post("/rooms", data);
      return res.data.room || res.data.data || res.data || null;
    } catch (error) {
      console.warn("Failed to create room", error);
      return null;
    }
  }

  async startRoom(id: string): Promise<boolean> {
    if (!id) return false;
    try {
      await authenticatedClient.post(`/rooms/${id}/start`);
      return true;
    } catch (error) {
      console.warn("Failed to start room", error);
      return false;
    }
  }

  async endRoom(id: string): Promise<boolean> {
    if (!id) return false;
    try {
      await authenticatedClient.post(`/rooms/${id}/end`);
      return true;
    } catch (error) {
      console.warn("Failed to end room", error);
      return false;
    }
  }

  async joinRoom(id: string): Promise<boolean> {
    if (!id) return false;
    try {
      await authenticatedClient.post(`/rooms/${id}/join`);
      return true;
    } catch (error) {
      console.warn("Failed to join room", error);
      return false;
    }
  }

  async leaveRoom(id: string): Promise<boolean> {
    if (!id) return false;
    try {
      await authenticatedClient.post(`/rooms/${id}/leave`);
      return true;
    } catch (error) {
      console.warn("Failed to leave room", error);
      return false;
    }
  }

  async startStream(id: string, data: { url: string; title?: string; image?: string; description?: string }): Promise<{ ingressId: string; url: string } | null> {
    if (!id) return null;
    try {
      const res = await authenticatedClient.post(`/rooms/${id}/stream`, data);
      return res.data;
    } catch (error) {
      console.warn("Failed to start stream", error);
      return null;
    }
  }

  async generateStreamKey(id: string, data?: { title?: string; image?: string; description?: string }): Promise<{ rtmpUrl: string; streamKey: string } | null> {
    if (!id) return null;
    const res = await authenticatedClient.post(`/rooms/${id}/stream/rtmp`, data || {});
    return res.data;
  }

  async updateStreamMetadata(id: string, data: { title?: string; image?: string; description?: string }): Promise<boolean> {
    if (!id) return false;
    try {
      await authenticatedClient.patch(`/rooms/${id}/stream`, data);
      return true;
    } catch (error) {
      console.warn("Failed to update stream metadata", error);
      return false;
    }
  }

  async stopStream(id: string): Promise<boolean> {
    if (!id) return false;
    try {
      await authenticatedClient.delete(`/rooms/${id}/stream`);
      return true;
    } catch (error) {
      console.warn("Failed to stop stream", error);
      return false;
    }
  }
}

export const roomsService = new RoomsService();
