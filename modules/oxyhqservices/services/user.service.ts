import { apiService } from './api.service';
import { User } from './auth.service';
import { OxyProfile } from '../types';
import { getData, storeData } from '../utils/storage';
import { profileService } from './profile.service';

interface UserDataResponse {
  user: User;
  profile: OxyProfile;
  accessToken: string;
}

interface UserSession {
  id: string;
  accessToken: string;
  refreshToken?: string;
  lastRefresh: number;
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

  async addUserSession(user: User, accessToken: string): Promise<void> {
    try {
      const sessions = await this.getUserSessions();
      const sessionData: UserSession = {
        id: user.id,
        accessToken,
        lastRefresh: Date.now()
      };
      
      const existingIndex = sessions.findIndex(s => s.id === user.id);
      
      if (existingIndex !== -1) {
        sessions[existingIndex] = sessionData;
      } else {
        sessions.push(sessionData);
      }
      
      await storeData('sessions', sessions);
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
      // Get current refresh token
      const refreshToken = await getData('refreshToken');
      if (!refreshToken) {
        throw new Error('No refresh token available');
      }

      // First refresh the tokens
      const tokenResponse = await apiService.post<{ accessToken: string; refreshToken: string }>('/auth/refresh', { refreshToken });
      
      // Store new tokens
      await Promise.all([
        storeData('accessToken', tokenResponse.data.accessToken),
        storeData('refreshToken', tokenResponse.data.refreshToken)
      ]);

      // Then fetch user data with new token
      const userResponse = await apiService.get<{ user: User }>(`/users/${userId}`);

      return {
        user: userResponse.data.user,
        profile: userResponse.data.user,
        accessToken: tokenResponse.data.accessToken
      };
    } catch (error) {
      console.error('Error refreshing user data:', error);
      throw error;
    }
  }
}

export const userService = new UserService();