import type { Space } from '../types';

type HttpClient = {
  get: (url: string, config?: any) => Promise<any>;
  post: (url: string, data?: any, config?: any) => Promise<any>;
  patch: (url: string, data?: any, config?: any) => Promise<any>;
  delete: (url: string, config?: any) => Promise<any>;
};

export function createSpacesService(httpClient: HttpClient) {
  return {
    async getSpaces(status?: string): Promise<Space[]> {
      try {
        const params: any = {};
        if (status) params.status = status;
        const res = await httpClient.get("/spaces", { params });
        return res.data.spaces || res.data.data || res.data || [];
      } catch (error) {
        console.warn("Failed to fetch spaces", error);
        return [];
      }
    },

    async getSpace(id: string): Promise<Space | null> {
      if (!id) return null;
      try {
        const res = await httpClient.get(`/spaces/${id}`);
        return res.data.space || res.data.data || res.data || null;
      } catch (error) {
        console.warn("Failed to fetch space", error);
        return null;
      }
    },

    async createSpace(data: { title: string; description?: string; topic?: string; scheduledStart?: string; speakerPermission?: 'everyone' | 'followers' | 'invited' }): Promise<Space | null> {
      try {
        const res = await httpClient.post("/spaces", data);
        return res.data.space || res.data.data || res.data || null;
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
        return res.data;
      } catch (error) {
        console.warn("Failed to start stream", error);
        return null;
      }
    },

    async generateStreamKey(id: string, data?: { title?: string; image?: string; description?: string }): Promise<{ rtmpUrl: string; streamKey: string } | null> {
      if (!id) return null;
      const res = await httpClient.post(`/spaces/${id}/stream/rtmp`, data || {});
      return res.data;
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
  };
}

export type SpacesServiceInstance = ReturnType<typeof createSpacesService>;
