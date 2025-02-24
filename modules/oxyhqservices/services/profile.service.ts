import { apiService } from './api.service';
import type { OxyProfile } from '../types';

class ProfileService {
  async getProfileById(userId: string): Promise<OxyProfile> {
    try {
      const response = await apiService.get<OxyProfile>(`/users/${userId}`);
      return response.data;
    } catch (error) {
      console.error('Error fetching profile:', error);
      throw error;
    }
  }

  async getProfileByUsername(username: string): Promise<OxyProfile> {
    try {
      const response = await apiService.get<OxyProfile>(`/users/username/${username}`);
      return response.data;
    } catch (error) {
      console.error('Error fetching profile by username:', error);
      throw error;
    }
  }

  async updateProfile(data: Partial<OxyProfile>): Promise<OxyProfile> {
    try {
      const userId = data._id || data.userID;
      if (!userId) {
        throw new Error('User ID is required for profile update');
      }
      
      const response = await apiService.put<OxyProfile>(`/users/${userId}`, {
        name: data.name,
        avatar: data.avatar,
        description: data.description,
        location: data.location,
        website: data.website,
        labels: data.labels
      });
      return response.data;
    } catch (error) {
      console.error('Error updating profile:', error);
      throw error;
    }
  }

  async follow(userId: string): Promise<{ action: 'follow' | 'unfollow'; counts: { followers: number; following: number } }> {
    if (!userId || typeof userId !== 'string') {
      throw new Error('Invalid user ID for following');
    }
    try {
      const response = await apiService.post<{
        message: string;
        action: 'follow' | 'unfollow';
        counts: { followers: number; following: number };
      }>(`/users/${userId}/follow`);
      return {
        action: response.data.action,
        counts: response.data.counts
      };
    } catch (error: any) {
      console.error('Error following user:', error);
      throw error;
    }
  }

  async unfollow(userId: string): Promise<void> {
    if (!userId || typeof userId !== 'string') {
      throw new Error('Invalid user ID for unfollowing');
    }
    try {
      await apiService.delete(`/users/${userId}/follow`);
    } catch (error: any) {
      console.error('Error unfollowing user:', error);
      throw error;
    }
  }

  async getFollowers(userId: string): Promise<OxyProfile[]> {
    try {
      const response = await apiService.get<OxyProfile[]>(`/users/${userId}/followers`);
      return response.data;
    } catch (error) {
      console.error('Error fetching followers:', error);
      throw error;
    }
  }

  async getFollowing(userId: string): Promise<OxyProfile[]> {
    try {
      const response = await apiService.get<OxyProfile[]>(`/users/${userId}/following`);
      return response.data;
    } catch (error) {
      console.error('Error fetching following:', error);
      throw error;
    }
  }

  async getFollowingStatus(userId: string): Promise<boolean> {
    if (!userId || typeof userId !== 'string') {
      throw new Error('Invalid user ID for getting following status');
    }
    try {
      const response = await apiService.get<{ isFollowing: boolean }>(`/users/${userId}/following-status`);
      return response.data.isFollowing;
    } catch (error: any) {
      console.error('Error getting following status:', error);
      throw error;
    }
  }

  async updatePrivacySettings(userId: string, settings: Partial<OxyProfile['privacySettings']>): Promise<OxyProfile> {
    try {
      const response = await apiService.put<OxyProfile>(`/users/${userId}/privacy`, settings);
      return response.data;
    } catch (error) {
      console.error('Error updating privacy settings:', error);
      throw error;
    }
  }
}

export const profileService = new ProfileService();