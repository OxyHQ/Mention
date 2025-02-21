import { apiService } from './api.service';
import type { OxyProfile } from '../types';

class ProfileService {
  async getProfileById(userId: string): Promise<OxyProfile> {
    const response = await apiService.get<OxyProfile>(`/profiles/${userId}`);
    return response.data;
  }

  async getProfileByUsername(username: string): Promise<OxyProfile> {
    const response = await apiService.get<OxyProfile>(`/profiles/username/${username}`);
    return response.data;
  }

  async updateProfile(data: Partial<OxyProfile>): Promise<OxyProfile> {
    const response = await apiService.patch<OxyProfile>(`/profiles/${data.userID}`, data);
    return response.data;
  }

  async follow(userId: string): Promise<void> {
    await apiService.post(`/profiles/${userId}/follow`);
  }

  async unfollow(userId: string): Promise<void> {
    await apiService.delete(`/profiles/${userId}/follow`);
  }

  async getFollowers(userId: string): Promise<OxyProfile[]> {
    const response = await apiService.get<OxyProfile[]>(`/profiles/${userId}/followers`);
    return response.data;
  }

  async getFollowing(userId: string): Promise<OxyProfile[]> {
    const response = await apiService.get<OxyProfile[]>(`/profiles/${userId}/following`);
    return response.data;
  }

  async getFollowingStatus(userId: string): Promise<boolean> {
    const response = await apiService.get<{ isFollowing: boolean }>(`/profiles/${userId}/following-status`);
    return response.data.isFollowing;
  }
}

export const profileService = new ProfileService();