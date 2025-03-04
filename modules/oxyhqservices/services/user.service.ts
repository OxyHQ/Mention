import { apiService } from './api.service';
import { User } from './auth.service';
import { OxyProfile } from '../types';
import { getData, storeData, getSecureData, storeSecureData } from '../utils/storage';
import { profileService } from './profile.service';

interface UserDataResponse {
  user: User;
  profile: OxyProfile;
  accessToken: string;
  refreshToken: string;
}

export interface UserSession {
  id: string;
  profile?: OxyProfile;
}

class UserService {
  async getSessions(): Promise<{ data: UserSession[] }> {
    try {
      const sessions = await this.getUserSessions();
      const enrichedSessions = await Promise.all(
        sessions.map(async (session) => {
          const profile = await profileService.getProfileById(session.id);
          return {
            ...session,
            profile
          };
        })
      );
      return {
        data: enrichedSessions
      };
    } catch (error) {
      console.error('Error getting user sessions:', error);
      return { data: [] };
    }
  }

  private async getUserSessions(): Promise<UserSession[]> {
    try {
      const sessions: UserSession[] = await getData('sessions') || [];
      return sessions;
    } catch (error) {
      console.error('Error getting user sessions:', error);
      return [];
    }
  }

  async addUserSession(user: User, accessToken: string, refreshToken?: string): Promise<void> {
    try {
      const sessions = await this.getUserSessions();
      const sessionData: UserSession = {
        id: user.id
      };
      
      const existingIndex = sessions.findIndex(s => s.id === user.id);
      
      if (existingIndex !== -1) {
        sessions[existingIndex] = sessionData;
      } else {
        sessions.push(sessionData);
      }
      
      // Store tokens securely and session data
      await Promise.all([
        storeSecureData('accessToken', accessToken),
        refreshToken ? storeSecureData('refreshToken', refreshToken) : Promise.resolve(),
        storeData('sessions', sessions)
      ]);
    } catch (error) {
      console.error('Error adding user session:', error);
      throw error;
    }
  }

  async removeUserSession(userId: string): Promise<void> {
    try {
      const sessions = await this.getUserSessions();
      const updatedSessions = sessions.filter(s => s.id !== userId);
      await storeData('sessions', updatedSessions);
    } catch (error) {
      console.error('Error removing user session:', error);
      throw error;
    }
  }

  async refreshUserData(userId: string): Promise<UserDataResponse> {
    try {
      const response = await apiService.get<UserDataResponse>(`/users/${userId}/refresh`);
      return response.data;
    } catch (error) {
      console.error('Error refreshing user data:', error);
      throw error;
    }
  }
  
  async getActiveSession(): Promise<UserSession | null> {
    try {
      const sessions = await this.getUserSessions();
      // Return the last session as the active one
      return sessions.length > 0 ? sessions[sessions.length - 1] : null;
    } catch (error) {
      console.error('Error getting active session:', error);
      return null;
    }
  }
}

export const userService = new UserService();