import { fetchData, postData } from '@/utils/api';
import { OxyProfile } from '../types';

class ProfileService {
  private static instance: ProfileService;

  private constructor() {}

  public static getInstance(): ProfileService {
    if (!ProfileService.instance) {
      ProfileService.instance = new ProfileService();
    }
    return ProfileService.instance;
  }

  async getProfileById(id: string): Promise<OxyProfile> {
    try {
      const response = await fetchData<{ data: OxyProfile }>(`profiles/${id}`);
      return response.data;
    } catch (error) {
      console.error('Error fetching profile by ID:', error);
      throw error;
    }
  }

  async getProfileByUsername(username: string): Promise<OxyProfile> {
    try {
      const response = await fetchData<{ data: OxyProfile }>(`profiles/username/${username}`);
      return response.data;
    } catch (error) {
      console.error('Error fetching profile by username:', error);
      throw error;
    }
  }

  async updateProfile(id: string, data: Partial<OxyProfile>): Promise<OxyProfile> {
    try {
      const response = await postData(`profiles/${id}`, data);
      return response.data;
    } catch (error) {
      console.error('Error updating profile:', error);
      throw error;
    }
  }
}

export const profileService = ProfileService.getInstance(); 