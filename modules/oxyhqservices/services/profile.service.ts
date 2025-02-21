import { apiService } from './api.service';
import type { OxyProfile } from '../types';

class ProfileService {
  async getProfileById(userId: string): Promise<OxyProfile> {
    if (!userId || typeof userId !== 'string') {
      throw new Error('Invalid user ID');
    }
    const response = await apiService.get<OxyProfile>(`/profiles/${userId}`);
    return response.data;
  }

  async getProfileByUsername(username: string): Promise<OxyProfile> {
    if (!username || typeof username !== 'string') {
      throw new Error('Invalid username');
    }
    const response = await apiService.get<OxyProfile>(`/profiles/username/${username}`);
    return response.data;
  }

  async updateProfile(data: Partial<OxyProfile>): Promise<OxyProfile> {
    if (!data.userID || typeof data.userID !== 'string') {
      throw new Error('Invalid user ID for profile update');
    }
    const response = await apiService.patch<OxyProfile>(`/profiles/${data.userID}`, data);
    return response.data;
  }

  async follow(userId: string): Promise<void> {
    if (!userId || typeof userId !== 'string') {
      throw new Error('Invalid user ID for following');
    }
    await apiService.post(`/profiles/${userId}/follow`);
  }

  async unfollow(userId: string): Promise<void> {
    if (!userId || typeof userId !== 'string') {
      throw new Error('Invalid user ID for unfollowing');
    }
    await apiService.delete(`/profiles/${userId}/follow`);
  }

  async getFollowers(userId: string): Promise<OxyProfile[]> {
    if (!userId || typeof userId !== 'string') {
      throw new Error('Invalid user ID for getting followers');
    }
    const response = await apiService.get<{ followers: OxyProfile[]; _count: number }>(`/profiles/${userId}/followers`);
    return response.data.followers;
  }

  async getFollowing(userId: string): Promise<OxyProfile[]> {
    if (!userId || typeof userId !== 'string') {
      throw new Error('Invalid user ID for getting following');
    }
    const response = await apiService.get<{ following: OxyProfile[]; _count: number }>(`/profiles/${userId}/following`);
    return response.data.following;
  }

  async getFollowingStatus(userId: string): Promise<boolean> {
    if (!userId || typeof userId !== 'string') {
      throw new Error('Invalid user ID for getting following status');
    }
    const response = await apiService.get<{ isFollowing: boolean }>(`/profiles/${userId}/following-status`);
    return response.data.isFollowing;
  }
}

export const profileService = new ProfileService();