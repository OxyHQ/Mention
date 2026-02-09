import type { Room, HttpClient } from '../types';
import { validateRooms, validateRoom, ZStartStreamResponse, ZGenerateStreamKeyResponse } from '../validation';

export interface CreateRoomData {
  title: string;
  description?: string;
  topic?: string;
  scheduledStart?: string;
  speakerPermission?: 'everyone' | 'followers' | 'invited';
  type?: 'talk' | 'stage' | 'broadcast';
  ownerType?: 'profile' | 'house';
  houseId?: string;
  broadcastKind?: 'user';
}

export function createAgoraService(httpClient: HttpClient) {
  return {
    async getRooms(status?: string, type?: string): Promise<Room[]> {
      try {
        const params: Record<string, string> = {};
        if (status) params.status = status;
        if (type) params.type = type;
        const res = await httpClient.get("/rooms", { params });
        const raw = res.data.rooms || res.data.data || res.data || [];
        return validateRooms(Array.isArray(raw) ? raw : []);
      } catch (error) {
        console.warn("Failed to fetch rooms", error);
        return [];
      }
    },

    async getRoom(id: string): Promise<Room | null> {
      if (!id) return null;
      try {
        const res = await httpClient.get(`/rooms/${id}`);
        const raw = res.data.room || res.data.data || res.data || null;
        return raw ? validateRoom(raw) : null;
      } catch (error) {
        console.warn("Failed to fetch room", error);
        return null;
      }
    },

    async createRoom(data: CreateRoomData): Promise<Room | null> {
      try {
        const res = await httpClient.post("/rooms", data as Record<string, unknown>);
        const raw = res.data.room || res.data.data || res.data || null;
        return raw ? validateRoom(raw) : null;
      } catch (error) {
        console.warn("Failed to create room", error);
        return null;
      }
    },

    async startRoom(id: string): Promise<boolean> {
      if (!id) return false;
      try {
        await httpClient.post(`/rooms/${id}/start`);
        return true;
      } catch (error) {
        console.warn("Failed to start room", error);
        return false;
      }
    },

    async endRoom(id: string): Promise<boolean> {
      if (!id) return false;
      try {
        await httpClient.post(`/rooms/${id}/end`);
        return true;
      } catch (error) {
        console.warn("Failed to end room", error);
        return false;
      }
    },

    async joinRoom(id: string): Promise<boolean> {
      if (!id) return false;
      try {
        await httpClient.post(`/rooms/${id}/join`);
        return true;
      } catch (error) {
        console.warn("Failed to join room", error);
        return false;
      }
    },

    async leaveRoom(id: string): Promise<boolean> {
      if (!id) return false;
      try {
        await httpClient.post(`/rooms/${id}/leave`);
        return true;
      } catch (error) {
        console.warn("Failed to leave room", error);
        return false;
      }
    },

    async startStream(id: string, data: { url: string; title?: string; image?: string; description?: string }): Promise<{ ingressId: string; url: string } | null> {
      if (!id) return null;
      try {
        const res = await httpClient.post(`/rooms/${id}/stream`, data);
        const parsed = ZStartStreamResponse.safeParse(res.data);
        if (!parsed.success) {
          console.warn('[agora] Invalid startStream response:', parsed.error.issues[0]);
          return null;
        }
        return parsed.data;
      } catch (error) {
        console.warn("Failed to start stream", error);
        return null;
      }
    },

    async generateStreamKey(id: string, data?: { title?: string; image?: string; description?: string }): Promise<{ rtmpUrl: string; streamKey: string } | null> {
      if (!id) return null;
      const res = await httpClient.post(`/rooms/${id}/stream/rtmp`, data || {});
      const parsed = ZGenerateStreamKeyResponse.safeParse(res.data);
      if (!parsed.success) {
        console.warn('[agora] Invalid generateStreamKey response:', parsed.error.issues[0]);
        return null;
      }
      return parsed.data;
    },

    async updateStreamMetadata(id: string, data: { title?: string; image?: string; description?: string }): Promise<boolean> {
      if (!id) return false;
      try {
        await httpClient.patch(`/rooms/${id}/stream`, data);
        return true;
      } catch (error) {
        console.warn("Failed to update stream metadata", error);
        return false;
      }
    },

    async stopStream(id: string): Promise<boolean> {
      if (!id) return false;
      try {
        await httpClient.delete(`/rooms/${id}/stream`);
        return true;
      } catch (error) {
        console.warn("Failed to stop stream", error);
        return false;
      }
    },

    async deleteRoom(id: string): Promise<boolean> {
      if (!id) return false;
      try {
        await httpClient.delete(`/rooms/${id}`);
        return true;
      } catch (error) {
        console.warn("Failed to delete room", error);
        return false;
      }
    },

    async archiveRoom(id: string): Promise<{ success: boolean; archived: boolean }> {
      if (!id) return { success: false, archived: false };
      try {
        const res = await httpClient.patch(`/rooms/${id}/archive`);
        return {
          success: res.data.success !== undefined ? Boolean(res.data.success) : true,
          archived: res.data.archived !== undefined ? Boolean(res.data.archived) : true,
        };
      } catch (error) {
        console.warn("Failed to archive room", error);
        return { success: false, archived: false };
      }
    },
  };
}

export type AgoraServiceInstance = ReturnType<typeof createAgoraService>;
