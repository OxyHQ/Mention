import { OxyServices } from '@oxyhq/services';
import { Platform } from 'react-native';
import { API_URL } from '@/config';

// API Configuration
const API_CONFIG = {
  baseURL: API_URL,
  endpoints: {
    health: '/api/health',
    profiles: '/api/profiles',         // For user profiles (GET, POST, etc.)
    posts: '/api/posts',               // For creating posts
    feed: '/api/feed',                 // For fetching feeds (explore, home, etc.)
    hashtags: '/api/hashtags',         // For trends
    analytics: '/api/analytics',       // For analytics data
    data: '/api/data',
    recentProperties: '/api/profiles/me/recent-properties',
    savedProperties: '/api/profiles/me/saved-properties',
    saveProperty: '/api/profiles/me/save-property',
    savedSearches: '/api/profiles/me/saved-searches',
    properties: '/api/profiles/me/properties',
  },
};

export interface ApiResponse<T = any> {
  success: boolean;
  message?: string;
  error?: string;
  data?: T;
}

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

/**
 * Custom API Error class for handling API-specific errors
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public status?: number,
    public response?: any
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Standard REST API methods for consistent usage across the app
 */
export const api = {
  /**
   * GET request
   */
  async get<T = any>(
    endpoint: string, 
    options?: { 
      params?: Record<string, any>;
      oxyServices?: OxyServices;
      activeSessionId?: string;
    }
  ): Promise<{ data: T }> {
    const url = new URL(`${API_CONFIG.baseURL}${endpoint}`);
    
    // Add query parameters if provided
    if (options?.params) {
      Object.entries(options.params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          url.searchParams.append(key, String(value));
        }
      });
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Handle authentication if OxyServices is provided
    if (options?.oxyServices && options?.activeSessionId) {
      try {
        const tokenData = await options.oxyServices.getTokenBySession(options.activeSessionId);
        
        if (!tokenData) {
          throw new ApiError('No authentication token found', 401);
        }
        
        headers['Authorization'] = `Bearer ${tokenData.accessToken}`;
      } catch (error) {
        console.error('Failed to get token:', error);
        throw new ApiError('Authentication failed', 401);
      }
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers,
    });

    const data = await response.json();

    if (!response.ok) {
      throw new ApiError(
        data.message || data.error || `HTTP ${response.status}`,
        response.status,
        data
      );
    }

    return { data };
  },

  /**
   * POST request
   */
  async post<T = any>(
    endpoint: string, 
    body?: any,
    options?: {
      oxyServices?: OxyServices;
      activeSessionId?: string;
    }
  ): Promise<{ data: T }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Handle authentication if OxyServices is provided
    if (options?.oxyServices && options?.activeSessionId) {
      try {
        const tokenData = await options.oxyServices.getTokenBySession(options.activeSessionId);
        
        if (!tokenData) {
          throw new ApiError('No authentication token found', 401);
        }
        
        headers['Authorization'] = `Bearer ${tokenData.accessToken}`;
      } catch (error) {
        console.error('Failed to get token:', error);
        throw new ApiError('Authentication failed', 401);
      }
    }

    const response = await fetch(`${API_CONFIG.baseURL}${endpoint}`, {
      method: 'POST',
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await response.json();

    if (!response.ok) {
      throw new ApiError(
        data.message || data.error || `HTTP ${response.status}`,
        response.status,
        data
      );
    }

    return { data };
  },

  /**
   * PUT request
   */
  async put<T = any>(
    endpoint: string, 
    body?: any,
    options?: {
      oxyServices?: OxyServices;
      activeSessionId?: string;
    }
  ): Promise<{ data: T }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Handle authentication if OxyServices is provided
    if (options?.oxyServices && options?.activeSessionId) {
      try {
        const tokenData = await options.oxyServices.getTokenBySession(options.activeSessionId);
        
        if (!tokenData) {
          throw new ApiError('No authentication token found', 401);
        }
        
        headers['Authorization'] = `Bearer ${tokenData.accessToken}`;
      } catch (error) {
        console.error('Failed to get token:', error);
        throw new ApiError('Authentication failed', 401);
      }
    }

    const response = await fetch(`${API_CONFIG.baseURL}${endpoint}`, {
      method: 'PUT',
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await response.json();

    if (!response.ok) {
      throw new ApiError(
        data.message || data.error || `HTTP ${response.status}`,
        response.status,
        data
      );
    }

    return { data };
  },

  /**
   * DELETE request
   */
  async delete<T = any>(
    endpoint: string,
    options?: {
      oxyServices?: OxyServices;
      activeSessionId?: string;
    }
  ): Promise<{ data: T }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Handle authentication if OxyServices is provided
    if (options?.oxyServices && options?.activeSessionId) {
      try {
        const tokenData = await options.oxyServices.getTokenBySession(options.activeSessionId);
        
        if (!tokenData) {
          throw new ApiError('No authentication token found', 401);
        }
        
        headers['Authorization'] = `Bearer ${tokenData.accessToken}`;
      } catch (error) {
        console.error('Failed to get token:', error);
        throw new ApiError('Authentication failed', 401);
      }
    }

    const response = await fetch(`${API_CONFIG.baseURL}${endpoint}`, {
      method: 'DELETE',
      headers,
    });

    const data = await response.json();

    if (!response.ok) {
      throw new ApiError(
        data.message || data.error || `HTTP ${response.status}`,
        response.status,
        data
      );
    }

    return { data };
  },

  /**
   * PATCH request
   */
  async patch<T = any>(
    endpoint: string, 
    body?: any,
    options?: {
      oxyServices?: OxyServices;
      activeSessionId?: string;
    }
  ): Promise<{ data: T }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Handle authentication if OxyServices is provided
    if (options?.oxyServices && options?.activeSessionId) {
      try {
        const tokenData = await options.oxyServices.getTokenBySession(options.activeSessionId);
        
        if (!tokenData) {
          throw new ApiError('No authentication token found', 401);
        }
        
        headers['Authorization'] = `Bearer ${tokenData.accessToken}`;
      } catch (error) {
        console.error('Failed to get token:', error);
        throw new ApiError('Authentication failed', 401);
      }
    }

    const response = await fetch(`${API_CONFIG.baseURL}${endpoint}`, {
      method: 'PATCH',
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await response.json();

    if (!response.ok) {
      throw new ApiError(
        data.message || data.error || `HTTP ${response.status}`,
        response.status,
        data
      );
    }

    return { data };
  },
};

/**
 * Profile API functions for user profile management
 * All functions require authentication via OxyServices
 */
export const profileApi = {
  // Get user profile (authenticated) - creates personal profile if it doesn't exist
  async getUserProfile(oxyServices: OxyServices, activeSessionId: string): Promise<ApiResponse<UserProfile>> {
    try {
      const response = await api.get<ApiResponse<UserProfile>>(API_CONFIG.endpoints.profiles, {
        oxyServices,
        activeSessionId,
      });
      return response.data;
    } catch (error) {
      // If profile doesn't exist (404), create a new personal profile
      if (error instanceof ApiError && error.status === 404) {
        try {
          // Get user info from token to create basic profile
          const tokenData = await oxyServices.getTokenBySession(activeSessionId);
          if (!tokenData) {
            throw new ApiError('No authentication token found', 401);
          }

          // Create basic personal profile with minimal required data
          const basicProfileData = {
            // The backend should extract user info from the authenticated token
            // We're just sending a flag to indicate this is a personal profile creation
            isPersonalProfile: true,
          };

          const createResponse = await api.post<ApiResponse<UserProfile>>(
            API_CONFIG.endpoints.profiles, 
            basicProfileData,
            {
              oxyServices,
              activeSessionId,
            }
          );
          return createResponse.data;
        } catch (createError) {
          console.error('Failed to create personal profile:', createError);
          throw createError;
        }
      }
      // Re-throw other errors
      throw error;
    }
  },

  // Create personal profile (authenticated)
  async createPersonalProfile(oxyServices: OxyServices, activeSessionId: string): Promise<ApiResponse<UserProfile>> {
    const response = await api.post<ApiResponse<UserProfile>>(
      API_CONFIG.endpoints.profiles, 
      { isPersonalProfile: true },
      {
        oxyServices,
        activeSessionId,
      }
    );
    return response.data;
  },

  // Update user profile (authenticated)
  async updateUserProfile(profileData: Partial<UserProfile>, oxyServices: OxyServices, activeSessionId: string): Promise<ApiResponse<UserProfile>> {
    const response = await api.put<ApiResponse<UserProfile>>(API_CONFIG.endpoints.profiles, profileData, {
      oxyServices,
      activeSessionId,
    });
    return response.data;
  },
};

/**
 * Data API functions for general data operations
 * All functions require authentication via OxyServices
 */
export const dataApi = {
  // Get user data (authenticated)
  async getUserData(oxyServices: OxyServices, activeSessionId: string): Promise<ApiResponse> {
    const response = await api.get<ApiResponse>(API_CONFIG.endpoints.data, {
      oxyServices,
      activeSessionId,
    });
    return response.data;
  },

  // Create user data (authenticated)
  async createUserData(data: Record<string, any>, oxyServices: OxyServices, activeSessionId: string): Promise<ApiResponse> {
    const response = await api.post<ApiResponse>(API_CONFIG.endpoints.data, data, {
      oxyServices,
      activeSessionId,
    });
    return response.data;
  },
};

/**
 * User API functions for user-specific operations
 * All functions require authentication via OxyServices
 */
export const userApi = {
  // Get recently viewed properties (authenticated)
  async getRecentProperties(oxyServices: OxyServices, activeSessionId: string): Promise<ApiResponse> {
    const response = await api.get<ApiResponse>(API_CONFIG.endpoints.recentProperties, {
      oxyServices,
      activeSessionId,
    });
    return response.data;
  },

  // Track property view (authenticated)
  async trackPropertyView(propertyId: string, oxyServices: OxyServices, activeSessionId: string): Promise<ApiResponse> {
    const response = await api.post<ApiResponse>(`/api/properties/${propertyId}/track-view`, {}, {
      oxyServices,
      activeSessionId,
    });
    return response.data;
  },

  // Clear recently viewed properties (authenticated)
  async clearRecentProperties(oxyServices: OxyServices, activeSessionId: string): Promise<ApiResponse> {
    const response = await api.delete<ApiResponse>(API_CONFIG.endpoints.recentProperties, {
      oxyServices,
      activeSessionId,
    });
    return response.data;
  },

  // Get saved properties (authenticated)
  async getSavedProperties(oxyServices: OxyServices, activeSessionId: string): Promise<ApiResponse> {
    const response = await api.get<ApiResponse>(API_CONFIG.endpoints.savedProperties, {
      oxyServices,
      activeSessionId,
    });
    return response.data;
  },

  // Save a property (authenticated)
  async saveProperty(propertyId: string, notes: string | undefined, oxyServices: OxyServices, activeSessionId: string): Promise<ApiResponse> {
    const response = await api.post<ApiResponse>(API_CONFIG.endpoints.saveProperty, { propertyId, notes }, {
      oxyServices,
      activeSessionId,
    });
    return response.data;
  },

  // Unsave a property (authenticated)
  async unsaveProperty(propertyId: string, oxyServices: OxyServices, activeSessionId: string): Promise<ApiResponse> {
    const response = await api.delete<ApiResponse>(`${API_CONFIG.endpoints.savedProperties}/${propertyId}`, {
      oxyServices,
      activeSessionId,
    });
    return response.data;
  },

  // Update saved property notes (authenticated)
  async updateSavedPropertyNotes(propertyId: string, notes: string, oxyServices: OxyServices, activeSessionId: string): Promise<ApiResponse> {
    const response = await api.patch<ApiResponse>(`${API_CONFIG.endpoints.savedProperties}/${propertyId}/notes`, { notes }, {
      oxyServices,
      activeSessionId,
    });
    return response.data;
  },

  // Get user properties (authenticated)
  async getUserProperties(page: number = 1, limit: number = 10, oxyServices: OxyServices, activeSessionId: string): Promise<ApiResponse> {
    const response = await api.get<ApiResponse>(`${API_CONFIG.endpoints.properties}?page=${page}&limit=${limit}`, {
      oxyServices,
      activeSessionId,
    });
    return response.data;
  },

  // Get saved searches (authenticated)
  async getSavedSearches(oxyServices: OxyServices, activeSessionId: string): Promise<ApiResponse> {
    const response = await api.get<ApiResponse>(API_CONFIG.endpoints.savedSearches, {
      oxyServices,
      activeSessionId,
    });
    return response.data;
  },

  // Save a search (authenticated)
  async saveSearch(searchData: { name: string; query: string; filters?: any; notificationsEnabled?: boolean }, oxyServices: OxyServices, activeSessionId: string): Promise<ApiResponse> {
    const response = await api.post<ApiResponse>(API_CONFIG.endpoints.savedSearches, searchData, {
      oxyServices,
      activeSessionId,
    });
    return response.data;
  },

  // Delete a saved search (authenticated)
  async deleteSavedSearch(searchId: string, oxyServices: OxyServices, activeSessionId: string): Promise<ApiResponse> {
    const response = await api.delete<ApiResponse>(`${API_CONFIG.endpoints.savedSearches}/${searchId}`, {
      oxyServices,
      activeSessionId,
    });
    return response.data;
  },

  // Update a saved search (authenticated)
  async updateSavedSearch(searchId: string, searchData: { name?: string; query?: string; filters?: any; notificationsEnabled?: boolean }, oxyServices: OxyServices, activeSessionId: string): Promise<ApiResponse> {
    const response = await api.patch<ApiResponse>(`${API_CONFIG.endpoints.savedSearches}/${searchId}`, searchData, {
      oxyServices,
      activeSessionId,
    });
    return response.data;
  },

  // Toggle notifications for a saved search (authenticated)
  async toggleSearchNotifications(searchId: string, notificationsEnabled: boolean, oxyServices: OxyServices, activeSessionId: string): Promise<ApiResponse> {
    const response = await api.patch<ApiResponse>(`${API_CONFIG.endpoints.savedSearches}/${searchId}/notifications`, { notificationsEnabled }, {
      oxyServices,
      activeSessionId,
    });
    return response.data;
  },
};

// Web-compatible alert function
export function webAlert(title: string, message: string, buttons?: Array<{ text: string; style?: 'default' | 'cancel' | 'destructive'; onPress?: () => void }>) {
  if (Platform.OS === 'web') {
    if (buttons && buttons.length > 1) {
      // For confirmation dialogs, use browser confirm
      const result = window.confirm(`${title}\n\n${message}`);
      if (result) {
        // Find the non-cancel button and call its onPress
        const confirmButton = buttons.find(btn => btn.style !== 'cancel');
        if (confirmButton?.onPress) {
          confirmButton.onPress();
        }
      } else {
        // Find the cancel button and call its onPress
        const cancelButton = buttons.find(btn => btn.style === 'cancel');
        if (cancelButton?.onPress) {
          cancelButton.onPress();
        }
      }
    } else {
      // For simple alerts, use browser alert
      window.alert(`${title}\n\n${message}`);
      if (buttons?.[0]?.onPress) {
        buttons[0].onPress();
      }
    }
  } else {
    // On mobile, use React Native Alert
    const { Alert } = require('react-native');
    Alert.alert(title, message, buttons);
  }
}

// Health check API
export const healthApi = {
  // Check server health (public endpoint)
  async checkHealth(): Promise<ApiResponse> {
    const response = await api.get<ApiResponse>(API_CONFIG.endpoints.health);
    return response.data;
  },
};

/**
 * Sindi chat history API functions
 */
export const sindiApi = {
  // Get Sindi chat history (authenticated)
  async getSindiChatHistory(oxyServices: OxyServices, activeSessionId: string): Promise<{ history: any[] }> {
    const response = await api.get<{ history: any[] }>('/api/ai/history', {
      oxyServices,
      activeSessionId,
    });
    return response.data;
  },

  // Clear Sindi chat history (authenticated)
  async clearSindiChatHistory(oxyServices: OxyServices, activeSessionId: string): Promise<{ success: boolean }> {
    const response = await api.delete<{ success: boolean }>('/api/ai/history', {
      oxyServices,
      activeSessionId,
    });
    return response.data;
  },

  // Save Sindi chat history (user/assistant message pair)
  async saveSindiChatHistory(userMessage: string, assistantMessage: string, oxyServices: OxyServices, activeSessionId: string): Promise<{ success: boolean }> {
    const response = await api.post<{ success: boolean }>('/api/ai/history', {
      userMessage,
      assistantMessage,
    }, {
      oxyServices,
      activeSessionId,
    });
    return response.data;
  },
};

// Export the API configuration for external use
export { API_CONFIG };

// Default export with all APIs
export default {
  ...api,
  profile: profileApi,
  data: dataApi,
  health: healthApi,
  config: API_CONFIG,
  user: userApi,
  sindi: sindiApi,
};
