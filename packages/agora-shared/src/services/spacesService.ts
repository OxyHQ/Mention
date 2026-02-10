import type { Room, Recording, House, HttpClient } from '../types';
import { validateRooms, validateRoom, validateRecordings, validateHouse, ZStartStreamResponse, ZGenerateStreamKeyResponse } from '../validation';

export interface CreateRoomData {
  [key: string]: unknown;
  title: string;
  description?: string;
  topic?: string;
  scheduledStart?: string;
  speakerPermission?: 'everyone' | 'followers' | 'invited';
  type?: 'talk' | 'stage' | 'broadcast';
  ownerType?: 'profile' | 'house';
  houseId?: string;
  broadcastKind?: 'user';
  recordingEnabled?: boolean;
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
        const res = await httpClient.post("/rooms", data);
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

    async stopRoom(id: string): Promise<boolean> {
      if (!id) return false;
      try {
        await httpClient.post(`/rooms/${id}/stop`);
        return true;
      } catch (error) {
        console.warn("Failed to stop room", error);
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
      try {
        const res = await httpClient.post(`/rooms/${id}/stream/rtmp`, data || {});
        const parsed = ZGenerateStreamKeyResponse.safeParse(res.data);
        if (!parsed.success) {
          console.warn('[agora] Invalid generateStreamKey response:', parsed.error.issues[0]);
          return null;
        }
        return parsed.data;
      } catch (error) {
        console.warn("Failed to generate stream key", error);
        return null;
      }
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

    async getHouses(search?: string): Promise<House[]> {
      try {
        const params: Record<string, string> = {};
        if (search) params.search = search;
        const res = await httpClient.get("/houses", { params });
        const raw = res.data.houses || res.data.data || res.data || [];
        const items = Array.isArray(raw) ? raw : [];
        return items
          .map((h: unknown) => validateHouse(h))
          .filter((h): h is House => h !== null);
      } catch (error) {
        console.warn("Failed to fetch houses", error);
        return [];
      }
    },

    async getHouse(id: string): Promise<House | null> {
      if (!id) return null;
      try {
        const res = await httpClient.get(`/houses/${id}`);
        const raw = res.data.house || res.data.data || res.data || null;
        return raw ? validateHouse(raw) : null;
      } catch (error) {
        console.warn("Failed to fetch house", error);
        return null;
      }
    },

    async getMyHouses(userId: string): Promise<House[]> {
      if (!userId) return [];
      try {
        const houses = await this.getHouses();
        const ROLE_HIERARCHY: Record<string, number> = { member: 0, host: 1, admin: 2, owner: 3 };
        return houses.filter((h) =>
          h.members.some((m) => m.userId === userId && (ROLE_HIERARCHY[m.role] ?? 0) >= 1)
        );
      } catch (error) {
        console.warn("Failed to fetch user houses", error);
        return [];
      }
    },

    async getUserHouses(userId: string): Promise<House[]> {
      if (!userId) return [];
      try {
        const houses = await this.getHouses();
        return houses.filter((h) =>
          h.members.some((m) => m.userId === userId)
        );
      } catch (error) {
        console.warn("Failed to fetch user houses", error);
        return [];
      }
    },

    async getHouseRooms(houseId: string, status?: string): Promise<Room[]> {
      if (!houseId) return [];
      try {
        const params: Record<string, string> = {};
        if (status) params.status = status;
        const res = await httpClient.get(`/houses/${houseId}/rooms`, { params });
        const raw = res.data.rooms || res.data.data || res.data || [];
        return validateRooms(Array.isArray(raw) ? raw : []);
      } catch (error) {
        console.warn("Failed to fetch house rooms", error);
        return [];
      }
    },

    // --- Recording ---

    async startRecording(roomId: string): Promise<boolean> {
      if (!roomId) return false;
      try {
        await httpClient.post(`/rooms/${roomId}/recording/start`);
        return true;
      } catch (error) {
        console.warn("Failed to start recording", error);
        return false;
      }
    },

    async stopRecording(roomId: string): Promise<boolean> {
      if (!roomId) return false;
      try {
        await httpClient.post(`/rooms/${roomId}/recording/stop`);
        return true;
      } catch (error) {
        console.warn("Failed to stop recording", error);
        return false;
      }
    },

    async getRoomRecordings(roomId: string): Promise<Recording[]> {
      if (!roomId) return [];
      try {
        const res = await httpClient.get(`/rooms/${roomId}/recordings`);
        const raw = res.data.recordings || [];
        return validateRecordings(Array.isArray(raw) ? raw : []);
      } catch (error) {
        console.warn("Failed to fetch recordings", error);
        return [];
      }
    },

    async getRecording(recordingId: string): Promise<{ recording: Recording; playbackUrl: string } | null> {
      if (!recordingId) return null;
      try {
        const res = await httpClient.get(`/recordings/${recordingId}`);
        return res.data as any;
      } catch (error) {
        console.warn("Failed to fetch recording", error);
        return null;
      }
    },

    async updateRecordingAccess(recordingId: string, access: 'public' | 'participants'): Promise<boolean> {
      if (!recordingId) return false;
      try {
        await httpClient.patch(`/recordings/${recordingId}`, { access });
        return true;
      } catch (error) {
        console.warn("Failed to update recording access", error);
        return false;
      }
    },

    async deleteRecording(recordingId: string): Promise<boolean> {
      if (!recordingId) return false;
      try {
        await httpClient.delete(`/recordings/${recordingId}`);
        return true;
      } catch (error) {
        console.warn("Failed to delete recording", error);
        return false;
      }
    },

    async getRecordings(sortBy?: string, limit?: number): Promise<Recording[]> {
      try {
        const params: Record<string, string> = {};
        if (sortBy) params.sortBy = sortBy;
        if (limit) params.limit = String(limit);
        const res = await httpClient.get("/recordings", { params });
        const raw = res.data.recordings || res.data.data || res.data || [];
        return validateRecordings(Array.isArray(raw) ? raw : []);
      } catch (error) {
        console.warn("Failed to fetch recordings", error);
        return [];
      }
    },

    async getTopHosts(): Promise<{ userId: string; roomCount: number; totalListeners: number }[]> {
      try {
        const res = await httpClient.get("/rooms/top-hosts");
        const raw = res.data.hosts || res.data.data || res.data || [];
        return Array.isArray(raw) ? raw : [];
      } catch (error) {
        console.warn("Failed to fetch top hosts", error);
        return [];
      }
    },

    // --- Houses ---

    async createHouse(data: { name: string; description?: string; tags?: string[]; isPublic?: boolean }): Promise<House | null> {
      try {
        const res = await httpClient.post("/houses", data);
        const raw = res.data.house || res.data.data || res.data || null;
        return raw ? validateHouse(raw) : null;
      } catch (error) {
        console.warn("Failed to create house", error);
        return null;
      }
    },

    // --- Media uploads ---

    async uploadHouseAvatar(houseId: string, formData: FormData): Promise<string | null> {
      if (!houseId) return null;
      try {
        const res = await httpClient.post(`/houses/${houseId}/avatar`, formData);
        return res.data.avatar || null;
      } catch (error) {
        console.warn("Failed to upload house avatar", error);
        return null;
      }
    },

    async uploadHouseCover(houseId: string, formData: FormData): Promise<string | null> {
      if (!houseId) return null;
      try {
        const res = await httpClient.post(`/houses/${houseId}/cover`, formData);
        return res.data.coverImage || null;
      } catch (error) {
        console.warn("Failed to upload house cover", error);
        return null;
      }
    },

    async uploadRoomImage(roomId: string, formData: FormData): Promise<string | null> {
      if (!roomId) return null;
      try {
        const res = await httpClient.post(`/rooms/${roomId}/image`, formData);
        return res.data.streamImage || null;
      } catch (error) {
        console.warn("Failed to upload room image", error);
        return null;
      }
    },

    async uploadSeriesCover(seriesId: string, formData: FormData): Promise<string | null> {
      if (!seriesId) return null;
      try {
        const res = await httpClient.post(`/series/${seriesId}/cover`, formData);
        return res.data.coverImage || null;
      } catch (error) {
        console.warn("Failed to upload series cover", error);
        return null;
      }
    },
  };
}

export type AgoraServiceInstance = ReturnType<typeof createAgoraService>;
