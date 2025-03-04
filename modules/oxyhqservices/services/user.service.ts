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

interface UserSession {
  id: string;
  lastRefresh: number;
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
        id: user.id,
        lastRefresh: Date.now()
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
        storeData('sessions', sessions),
        storeData('userId', user.id)
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
      // Get current refresh token
      const refreshToken = await getSecureData<string>('refreshToken');
      
      if (!refreshToken) {
        throw new Error('No refresh token available');
      }
      
      // First refresh the tokens
      const tokenResponse = await apiService.post<{ accessToken: string; refreshToken: string }>('/auth/refresh', { refreshToken });
      
      // Store new tokens securely
      const newAccessToken = tokenResponse.data.accessToken;
      const newRefreshToken = tokenResponse.data.refreshToken || refreshToken;
      
      await Promise.all([
        storeSecureData('accessToken', newAccessToken),
        storeSecureData('refreshToken', newRefreshToken),
        storeData('lastTokenRefresh', Date.now())
      ]);
      
      // Update session
      await this.addUserSession({ id: userId } as User, newAccessToken, newRefreshToken);
      
      // Then fetch user data with new token
      const userResponse = await apiService.get<{ user: User }>(`/users/${userId}`);
      
      return {
        user: userResponse.data.user,
        profile: userResponse.data.user as unknown as OxyProfile,
        accessToken: newAccessToken,
        refreshToken: newRefreshToken
      };
    } catch (error) {
      console.error('Error refreshing user data:', error);
      throw error;
    }
  }
  
  async getActiveSession(): Promise<UserSession | null> {
    try {
      const userId = await getData<string>('userId');
      if (!userId) return null;
      
      const sessions = await this.getUserSessions();
      return sessions.find(s => s.id === userId) || null;
    } catch (error) {
      console.error('Error getting active session:', error);
      return null;
    }
  }
}

export const userService = new UserService();