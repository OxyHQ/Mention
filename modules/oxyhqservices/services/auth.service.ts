import axios from 'axios';
import { apiService } from './api.service';
import { storeData, getSecureData, storeSecureData, clearSecureData } from '../utils/storage';
import { userService } from './user.service';

export interface User {
  id: string;
  username: string;
  email: string;
  name?: {
    first?: string;
    last?: string;
  };
  avatar?: string;
  avatarSource?: {
    uri: string;
  };
}

interface LoginResponse {
  success: boolean;
  message: string;
  accessToken: string;
  refreshToken: string;
  user: User;
}

interface RegisterResponse {
  success: boolean;
  message: string;
  accessToken: string;
  refreshToken: string;
  user: User;
}

interface ValidateResponse {
  valid: boolean;
  message?: string;
}

interface RefreshResponse {
  accessToken: string;
  refreshToken?: string;
}

class AuthService {
  async register(user: { username: string; email: string; password: string }): Promise<RegisterResponse> {
    try {
      const response = await apiService.post<RegisterResponse>('/auth/register', user);
      
      if (response.data.success && response.data.accessToken && response.data.refreshToken) {
        // Store tokens and user data securely
        await Promise.all([
          storeSecureData('accessToken', response.data.accessToken),
          storeSecureData('refreshToken', response.data.refreshToken),
          storeData('user', response.data.user),
          storeData('userId', response.data.user.id)
        ]);
      }
      
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.data) {
        throw error.response.data;
      }
      throw error;
    }
  }

  async login(credentials: { username: string; password: string }): Promise<void> {
    // Validate credentials before making the request
    const validationErrors: { [key: string]: string | null } = {
      username: !credentials.username ? "Username is required" : null,
      password: !credentials.password ? "Password is required" : null
    };

    const hasErrors = Object.values(validationErrors).some(error => error !== null);
    if (hasErrors) {
      throw {
        message: "Username and password are required",
        details: validationErrors
      };
    }

    try {
      const response = await apiService.post<LoginResponse>('/auth/login', credentials);
      const { user, accessToken, refreshToken } = response.data;
      
      // Store tokens and user data securely
      await Promise.all([
        storeSecureData('accessToken', accessToken),
        storeSecureData('refreshToken', refreshToken),
        storeData('user', user),
        storeData('userId', user.id),
        userService.addUserSession(user, accessToken, refreshToken)
      ]);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.data) {
        if (error.response.data.details) {
          throw {
            message: error.response.data.message,
            details: error.response.data.details
          };
        }
        throw error.response.data;
      }
      console.error('Login error:', error);
      throw error;
    }
  }

  async validateCurrentSession(): Promise<boolean> {
    try {
      const accessToken = await getSecureData<string>('accessToken');
      if (!accessToken) return false;
      
      // Check if token needs refresh
      if (this.shouldRefreshToken(accessToken)) {
        const refreshResult = await this.refreshToken();
        if (!refreshResult) return false;
      }
      
      const response = await apiService.get<ValidateResponse>('/auth/validate');
      return response.data.valid;
    } catch (error) {
      return false;
    }
  }

  async refreshToken(): Promise<{ accessToken: string; refreshToken: string } | false> {
    try {
      const currentRefreshToken = await getSecureData<string>('refreshToken');
      if (!currentRefreshToken) {
        return false;
      }

      const response = await apiService.post<RefreshResponse>('/auth/refresh', {
        refreshToken: currentRefreshToken
      });

      const { accessToken, refreshToken = currentRefreshToken } = response.data;
      if (!accessToken) {
        throw new Error('Invalid refresh response');
      }

      // Store tokens securely
      await Promise.all([
        storeSecureData('accessToken', accessToken),
        storeSecureData('refreshToken', refreshToken)
      ]);

      return { accessToken, refreshToken };
    } catch (error) {
      console.error('Token refresh failed:', error);
      await this.logout();
      return false;
    }
  }

  public shouldRefreshToken(token: string): boolean {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return true;
      
      const payload = JSON.parse(atob(parts[1]));
      const exp = payload.exp * 1000; // Convert to milliseconds
      const now = Date.now();
      
      // Refresh if token expires in less than 5 minutes
      return exp - now < 5 * 60 * 1000;
    } catch (error) {
      console.error('Error checking token expiration:', error);
      return true;
    }
  }

  async logout(): Promise<void> {
    try {
      const session = await userService.getActiveSession();
      if (session?.id) {
        await userService.removeUserSession(session.id);
      }

      // Clear all secure data
      await Promise.all([
        clearSecureData('accessToken'),
        clearSecureData('refreshToken')
      ]);
    } catch (error) {
      console.error('Logout error:', error);
      throw error;
    }
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      const session = await userService.getActiveSession();
      const accessToken = await getSecureData<string>('accessToken');
      return !!(session && accessToken);
    } catch {
      return false;
    }
  }

  // Decode JWT and extract user ID
  async getCurrentSessionUserId(): Promise<string | null> {
    try {
      // First try to get the stored userId
      const userId = await getSecureData<string>('userId');
      if (userId) return userId;
      
      // If not available, try to decode from token
      const token = await getSecureData<string>('accessToken');
      if (!token) return null;
      
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      
      const payload = JSON.parse(atob(parts[1]));
      return payload.id || null;
    } catch (error) {
      console.error('Error decoding token:', error);
      return null;
    }
  }
}

export const authService = new AuthService();