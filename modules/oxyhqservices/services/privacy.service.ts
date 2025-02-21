import { apiService } from './api.service';
import type { PrivacySettings } from '../types';

interface BlockedUser {
  _id: string;
  username: string;
  avatar?: string;
  blockedAt: Date;
}

class PrivacyService {
  async getPrivacySettings(userId: string): Promise<PrivacySettings> {
    try {
      const response = await apiService.get<PrivacySettings>(`/privacy/${userId}/privacy`);
      return response.data;
    } catch (error) {
      throw error;
    }
  }

  async updatePrivacySettings(userId: string, settings: Partial<PrivacySettings>): Promise<PrivacySettings> {
    try {
      const response = await apiService.patch<PrivacySettings>(`/privacy/${userId}/privacy`, settings);
      return response.data;
    } catch (error) {
      throw error;
    }
  }

  async getBlockedUsers(userId: string): Promise<BlockedUser[]> {
    try {
      const response = await apiService.get<BlockedUser[]>('/privacy/blocked');
      return response.data;
    } catch (error) {
      throw error;
    }
  }

  async blockUser(targetId: string): Promise<void> {
    try {
      await apiService.post(`/privacy/blocked/${targetId}`, {});
    } catch (error) {
      throw error;
    }
  }

  async unblockUser(targetId: string): Promise<void> {
    try {
      await apiService.delete(`/privacy/blocked/${targetId}`);
    } catch (error) {
      throw error;
    }
  }
}

export const privacyService = new PrivacyService();