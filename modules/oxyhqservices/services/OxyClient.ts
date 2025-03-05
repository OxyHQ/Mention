import { apiService } from './api.service';
import { OXY_CLOUD_URL } from '../config';
import type { OxyProfile } from '../types';

export class OxyClient {
  private baseUrl: string = OXY_CLOUD_URL;

  async getFilesData(mediaIds: string[]): Promise<any[]> {
    if (!mediaIds || mediaIds.length === 0) return [];
    
    try {
      const response = await apiService.get(`/files/data/${mediaIds.filter(Boolean).join(",")}`);
      return Array.isArray(response.data) ? response.data : [];
    } catch (error) {
      console.error('Error fetching files data:', error);
      throw error;
    }
  }

  async getFileUrl(fileId: string): Promise<string> {
    if (!fileId) throw new Error('File ID is required');
    return `${this.baseUrl}/${fileId}`;
  }

  async getProfile(userId: string): Promise<OxyProfile> {
    if (!userId) throw new Error('User ID is required');
    
    try {
      const response = await apiService.get<OxyProfile>(`/users/${userId}`);
      return response.data;
    } catch (error) {
      console.error('Error fetching profile:', error);
      throw error;
    }
  }

  async getProfileByUsername(username: string): Promise<OxyProfile> {
    if (!username) throw new Error('Username is required');
    
    try {
      const response = await apiService.get<OxyProfile>(`/profiles/username/${username}`);
      return response.data;
    } catch (error) {
      console.error('Error fetching profile by username:', error);
      throw error;
    }
  }
}

export const oxyClient = new OxyClient();