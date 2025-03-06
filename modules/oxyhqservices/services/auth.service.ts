/**
 * Authentication Service
 * 
 * Manages user authentication, session validation, and token management.
 */

import axios from 'axios';
import { apiService } from './api.service';
import { storeData, getSecureData, storeSecureData, clearSecureData } from '../utils/storage';
import { userService } from './user.service';
import { ENDPOINTS, STORAGE_KEYS, ERROR_MESSAGES } from '../constants';

/**
 * User profile information
 */
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

/**
 * Response from login endpoint
 */
interface LoginResponse {
  success: boolean;
  message: string;
  accessToken: string;
  refreshToken: string;
  user: User;
}

/**
 * Response from registration endpoint
 */
interface RegisterResponse {
  success: boolean;
  message: string;
  accessToken: string;
  refreshToken: string;
  user: User;
}

/**
 * Response from session validation endpoint
 */
interface ValidateResponse {
  valid: boolean;
  message?: string;
}

/**
 * Response from token refresh endpoint
 */
interface RefreshResponse {
  accessToken: string;
  refreshToken?: string;
}

/**
 * Authentication service class
 */
class AuthService {
  /**
   * Register a new user
   */
  async register(user: { username: string; email: string; password: string }): Promise<RegisterResponse> {
    try {
      const response = await apiService.post<RegisterResponse>(
        ENDPOINTS.AUTH.REGISTER, 
        user
      );
      
      if (response.data.success && response.data.accessToken && response.data.refreshToken) {
        // Store tokens and user data securely
        await Promise.all([
          storeSecureData(STORAGE_KEYS.ACCESS_TOKEN, response.data.accessToken),
          storeSecureData(STORAGE_KEYS.REFRESH_TOKEN, response.data.refreshToken),
          storeData(STORAGE_KEYS.USER, response.data.user),
          storeData(STORAGE_KEYS.USER_ID, response.data.user.id)
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

  /**
   * Login a user with credentials
   */
  async login(credentials: { username: string; password: string }): Promise<void> {
    // Validate credentials before making the request
    const validationErrors: { [key: string]: string | null } = {
      username: !credentials.username ? "Username is required" : null,
      password: !credentials.password ? "Password is required" : null
    };
    
    const hasErrors = Object.values(validationErrors).some(error => error !== null);
    if (hasErrors) {
      throw {
        message: ERROR_MESSAGES.VALIDATION,
        details: validationErrors
      };
    }
    
    try {
      const response = await apiService.post<LoginResponse>(
        ENDPOINTS.AUTH.LOGIN, 
        credentials
      );
      
      const { user, accessToken, refreshToken } = response.data;
      
      // Store tokens and user data securely
      await Promise.all([
        storeSecureData(STORAGE_KEYS.ACCESS_TOKEN, accessToken),
        storeSecureData(STORAGE_KEYS.REFRESH_TOKEN, refreshToken),
        storeData(STORAGE_KEYS.USER, user),
        storeData(STORAGE_KEYS.USER_ID, user.id),
        userService.addUserSession(user, accessToken, refreshToken)
      ]);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.data) {
        if (error.response.data.details) {
          throw {
            message: error.response.data.message || ERROR_MESSAGES.VALIDATION,
            details: error.response.data.details
          };
        }
        throw error.response.data;
      }
      console.error('Login error:', error);
      throw error;
    }
  }

  /**
   * Validate the current user session
   */
  async validateCurrentSession(): Promise<boolean> {
    try {
      const accessToken = await getSecureData<string>(STORAGE_KEYS.ACCESS_TOKEN);
      if (!accessToken) return false;
      
      // Check if token needs refresh
      if (this.shouldRefreshToken(accessToken)) {
        const refreshResult = await this.refreshToken();
        if (!refreshResult) return false;
      }
      
      const response = await apiService.get<ValidateResponse>(ENDPOINTS.AUTH.VALIDATE);
      return response.data.valid;
    } catch (error) {
      return false;
    }
  }

  /**
   * Refresh the access token using the refresh token
   */
  async refreshToken(): Promise<{ accessToken: string; refreshToken: string } | false> {
    try {
      const currentRefreshToken = await getSecureData<string>(STORAGE_KEYS.REFRESH_TOKEN);
      if (!currentRefreshToken) {
        return false;
      }
      
      const response = await apiService.post<RefreshResponse>(
        ENDPOINTS.AUTH.REFRESH, 
        { refreshToken: currentRefreshToken }
      );
      
      const { accessToken, refreshToken = currentRefreshToken } = response.data;
      if (!accessToken) {
        throw new Error('Invalid refresh response');
      }
      
      // Store tokens securely
      await Promise.all([
        storeSecureData(STORAGE_KEYS.ACCESS_TOKEN, accessToken),
        storeSecureData(STORAGE_KEYS.REFRESH_TOKEN, refreshToken)
      ]);
      
      return { accessToken, refreshToken };
    } catch (error) {
      console.error('Token refresh failed:', error);
      await this.logout();
      return false;
    }
  }

  /**
   * Check if the token needs to be refreshed
   */
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

  /**
   * Logout the current user
   */
  async logout(): Promise<void> {
    try {
      const session = await userService.getActiveSession();
      if (session?.id) {
        await userService.removeUserSession(session.id);
      }
      
      // Clear all secure data
      await Promise.all([
        clearSecureData(STORAGE_KEYS.ACCESS_TOKEN),
        clearSecureData(STORAGE_KEYS.REFRESH_TOKEN)
      ]);
      
      // Optional: Call logout endpoint to invalidate on server
      try {
        await apiService.post(ENDPOINTS.AUTH.LOGOUT);
      } catch (error) {
        // Continue with logout even if server call fails
        console.warn('Server logout failed:', error);
      }
    } catch (error) {
      console.error('Logout error:', error);
      throw error;
    }
  }

  /**
   * Check if the user is authenticated
   */
  async isAuthenticated(): Promise<boolean> {
    try {
      const session = await userService.getActiveSession();
      const accessToken = await getSecureData<string>(STORAGE_KEYS.ACCESS_TOKEN);
      return !!(session && accessToken);
    } catch {
      return false;
    }
  }

  /**
   * Get the current user ID from stored data or JWT token
   */
  async getCurrentSessionUserId(): Promise<string | null> {
    try {
      // First try to get the stored userId
      const userId = await getSecureData<string>(STORAGE_KEYS.USER_ID);
      if (userId) return userId;
      
      // If not available, try to decode from token
      const token = await getSecureData<string>(STORAGE_KEYS.ACCESS_TOKEN);
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

  /**
   * Check if a username is available
   */
  async checkUsernameAvailability(username: string): Promise<{ available: boolean; message?: string }> {
    try {
      const response = await apiService.get<{ available: boolean; message?: string }>(
        `/auth/check-username/${username}`
      );
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.data) {
        return {
          available: false,
          message: error.response.data.message || 'Username is not available'
        };
      }
      throw error;
    }
  }
}

export const authService = new AuthService();