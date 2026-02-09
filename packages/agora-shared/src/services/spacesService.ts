import type { Space, HttpClient } from '../types';
import { validateSpaces, validateSpace, ZStartStreamResponse, ZGenerateStreamKeyResponse } from '../validation';

export function createAgoraService(httpClient: HttpClient) {
  return {
    async getSpaces(status?: string): Promise<Space[]> {
      try {
        const params: Record<string, string> = {};
        if (status) params.status = status;
        const res = await httpClient.get("/spaces", { params });
        const raw = res.data.spaces || res.data.data || res.data || [];
        return validateSpaces(Array.isArray(raw) ? raw : []);
      } catch (error) {
        console.warn("Failed to fetch spaces", error);
        return [];
      }
    },

    async getSpace(id: string): Promise<Space | null> {
      if (!id) return null;
      try {
        const res = await httpClient.get(`/spaces/${id}`);
        const raw = res.data.space || res.data.data || res.data || null;
        return raw ? validateSpace(raw) : null;
      } catch (error) {
        console.warn("Failed to fetch space", error);
        return null;
      }
    },

    async createSpace(data: { title: string; description?: string; topic?: string; scheduledStart?: string; speakerPermission?: 'everyone' | 'followers' | 'invited' }): Promise<Space | null> {
      try {
        const res = await httpClient.post("/spaces", data);
        const raw = res.data.space || res.data.data || res.data || null;
        return raw ? validateSpace(raw) : null;
      } catch (error) {
        console.warn("Failed to create space", error);
        return null;
      }
    },

    async startSpace(id: string): Promise<boolean> {
      if (!id) return false;
      try {
        await httpClient.post(`/spaces/${id}/start`);
        return true;
      } catch (error) {
        console.warn("Failed to start space", error);
        return false;
      }
    },

    async endSpace(id: string): Promise<boolean> {
      if (!id) return false;
      try {
        await httpClient.post(`/spaces/${id}/end`);
        return true;
      } catch (error) {
        console.warn("Failed to end space", error);
        return false;
      }
    },

    async joinSpace(id: string): Promise<boolean> {
      if (!id) return false;
      try {
        await httpClient.post(`/spaces/${id}/join`);
        return true;
      } catch (error) {
        console.warn("Failed to join space", error);
        return false;
      }
    },

    async leaveSpace(id: string): Promise<boolean> {
      if (!id) return false;
      try {
        await httpClient.post(`/spaces/${id}/leave`);
        return true;
      } catch (error) {
        console.warn("Failed to leave space", error);
        return false;
      }
    },

    async startStream(id: string, data: { url: string; title?: string; image?: string; description?: string }): Promise<{ ingressId: string; url: string } | null> {
      if (!id) return null;
      try {
        const res = await httpClient.post(`/spaces/${id}/stream`, data);
        const parsed = ZStartStreamResponse.safeParse(res.data);
        if (!parsed.success) {
          console.warn('[agora-shared] Invalid startStream response:', parsed.error.issues[0]);
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
      const res = await httpClient.post(`/spaces/${id}/stream/rtmp`, data || {});
      const parsed = ZGenerateStreamKeyResponse.safeParse(res.data);
      if (!parsed.success) {
        console.warn('[agora-shared] Invalid generateStreamKey response:', parsed.error.issues[0]);
        return null;
      }
      return parsed.data;
    },

    async updateStreamMetadata(id: string, data: { title?: string; image?: string; description?: string }): Promise<boolean> {
      if (!id) return false;
      try {
        await httpClient.patch(`/spaces/${id}/stream`, data);
        return true;
      } catch (error) {
        console.warn("Failed to update stream metadata", error);
        return false;
      }
    },

    async stopStream(id: string): Promise<boolean> {
      if (!id) return false;
      try {
        await httpClient.delete(`/spaces/${id}/stream`);
        return true;
      } catch (error) {
        console.warn("Failed to stop stream", error);
        return false;
      }
    },

    async deleteSpace(id: string): Promise<boolean> {
      if (!id) return false;
      try {
        await httpClient.delete(`/spaces/${id}`);
        return true;
      } catch (error) {
        console.warn("Failed to delete space", error);
        return false;
      }
    },

    async archiveSpace(id: string): Promise<{ success: boolean; archived: boolean }> {
      if (!id) return { success: false, archived: false };
      try {
        const res = await httpClient.patch(`/spaces/${id}/archive`);
        return {
          success: res.data.success !== undefined ? Boolean(res.data.success) : true,
          archived: res.data.archived !== undefined ? Boolean(res.data.archived) : true,
        };
      } catch (error) {
        console.warn("Failed to archive space", error);
        return { success: false, archived: false };
      }
    },
  };
}

export type AgoraServiceInstance = ReturnType<typeof createAgoraService>;
