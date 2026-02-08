import { authenticatedClient } from "@/utils/api";

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

class SpacesService {
  async getSpaces(status?: string): Promise<Space[]> {
    try {
      const params: any = {};
      if (status) params.status = status;
      const res = await authenticatedClient.get("/spaces", { params });
      return res.data.spaces || res.data.data || res.data || [];
    } catch (error) {
      console.warn("Failed to fetch spaces", error);
      return [];
    }
  }

  async getSpace(id: string): Promise<Space | null> {
    if (!id) return null;
    try {
      const res = await authenticatedClient.get(`/spaces/${id}`);
      return res.data.space || res.data.data || res.data || null;
    } catch (error) {
      console.warn("Failed to fetch space", error);
      return null;
    }
  }

  async createSpace(data: { title: string; description?: string; topic?: string; scheduledStart?: string; speakerPermission?: 'everyone' | 'followers' | 'invited' }): Promise<Space | null> {
    try {
      const res = await authenticatedClient.post("/spaces", data);
      return res.data.space || res.data.data || res.data || null;
    } catch (error) {
      console.warn("Failed to create space", error);
      return null;
    }
  }

  async startSpace(id: string): Promise<boolean> {
    if (!id) return false;
    try {
      await authenticatedClient.post(`/spaces/${id}/start`);
      return true;
    } catch (error) {
      console.warn("Failed to start space", error);
      return false;
    }
  }

  async endSpace(id: string): Promise<boolean> {
    if (!id) return false;
    try {
      await authenticatedClient.post(`/spaces/${id}/end`);
      return true;
    } catch (error) {
      console.warn("Failed to end space", error);
      return false;
    }
  }

  async joinSpace(id: string): Promise<boolean> {
    if (!id) return false;
    try {
      await authenticatedClient.post(`/spaces/${id}/join`);
      return true;
    } catch (error) {
      console.warn("Failed to join space", error);
      return false;
    }
  }

  async leaveSpace(id: string): Promise<boolean> {
    if (!id) return false;
    try {
      await authenticatedClient.post(`/spaces/${id}/leave`);
      return true;
    } catch (error) {
      console.warn("Failed to leave space", error);
      return false;
    }
  }

  async startStream(id: string, data: { url: string; title?: string; image?: string; description?: string }): Promise<{ ingressId: string; url: string } | null> {
    if (!id) return null;
    try {
      const res = await authenticatedClient.post(`/spaces/${id}/stream`, data);
      return res.data;
    } catch (error) {
      console.warn("Failed to start stream", error);
      return null;
    }
  }

  async generateStreamKey(id: string, data?: { title?: string; image?: string; description?: string }): Promise<{ rtmpUrl: string; streamKey: string } | null> {
    if (!id) return null;
    const res = await authenticatedClient.post(`/spaces/${id}/stream/rtmp`, data || {});
    return res.data;
  }

  async updateStreamMetadata(id: string, data: { title?: string; image?: string; description?: string }): Promise<boolean> {
    if (!id) return false;
    try {
      await authenticatedClient.patch(`/spaces/${id}/stream`, data);
      return true;
    } catch (error) {
      console.warn("Failed to update stream metadata", error);
      return false;
    }
  }

  async stopStream(id: string): Promise<boolean> {
    if (!id) return false;
    try {
      await authenticatedClient.delete(`/spaces/${id}/stream`);
      return true;
    } catch (error) {
      console.warn("Failed to stop stream", error);
      return false;
    }
  }
}

export const spacesService = new SpacesService();
