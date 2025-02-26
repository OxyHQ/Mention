import axios from 'axios';
import { apiService } from './api.service';
import { storeData, getData } from '@/utils/storage';

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
        // Store tokens and user data
        await Promise.all([
          storeData('accessToken', response.data.accessToken),
          storeData('refreshToken', response.data.refreshToken),
          storeData('user', response.data.user)
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

  async login(username: string, password: string): Promise<LoginResponse> {
    try {
      const response = await apiService.post<LoginResponse>('/auth/login', {
        username,
        password
      });

      if (!response.data.success || !response.data.accessToken || !response.data.refreshToken) {
        throw new Error(response.data.message || 'Login failed');
      }

      // Store tokens
      await Promise.all([
        storeData('accessToken', response.data.accessToken),
        storeData('refreshToken', response.data.refreshToken)
      ]);

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.data) {
        throw error;
      }
      throw new Error('Network error during login');
    }
  }

  async validateCurrentSession() {
    try {
      const response = await apiService.get<ValidateResponse>('/auth/validate');
      return response.data.valid;
    } catch (error) {
      return false;
    }
  }

  async refreshToken(): Promise<{ accessToken: string; refreshToken: string } | false> {
    try {
      const currentRefreshToken = await getData('refreshToken');
      if (!currentRefreshToken) {
        return false;
      }

      const response = await apiService.post<RefreshResponse>('/auth/refresh', {
        refreshToken: currentRefreshToken
      });

      const { accessToken, refreshToken } = response.data;
      if (!accessToken || !refreshToken) {
        throw new Error('Invalid refresh response');
      }

      await Promise.all([
        storeData('accessToken', accessToken),
        storeData('refreshToken', refreshToken)
      ]);

      return { accessToken, refreshToken };
    } catch (error) {
      console.error('Token refresh failed:', error);
      await this.logout();
      return false;
    }
  }

  async logout() {
    try {
      await Promise.all([
        storeData('accessToken', null),
        storeData('refreshToken', null),
        storeData('session', null),
        storeData('user', null),
        storeData('profile', null)
      ]);
    } catch (error) {
      console.error('Logout error:', error);
      throw error;
    }
  }

  // New method to decode JWT and extract user ID
  async getCurrentSessionUserId(): Promise<string | null> {
    try {
      const token = await getData<string>('accessToken');
      if (!token) return null;
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const payload = parts[1];
      // Replace '-' with '+' and '_' with '/' for base64url decode
      const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
      const jsonPayload = decodeURIComponent(
        atob(base64)
          .split('')
          .map(function(c) {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
          })
          .join('')
      );
      const obj = JSON.parse(jsonPayload);
      return obj.id || null;
    } catch (error) {
      console.error('Error decoding token:', error);
      return null;
    }
  }
}

export const authService = new AuthService();