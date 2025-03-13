/**
 * OxyClient Service
 * 
 * A client library for interacting with the OxyHQ platform APIs.
 * Provides methods for accessing files, user profiles, and managing sessions.
 */

import { apiService } from './api.service';
import { OXY_API_CONFIG } from '../config';
import { OxyProfile } from '../types';
import { getData, storeData } from '../utils/storage';
import { User } from './auth.service';
import { ENDPOINTS, STORAGE_KEYS, ERROR_MESSAGES } from '../constants';
import errorHandler from '../utils/errorHandler';

/**
 * Response from the sessions endpoint
 */
interface SessionResponse {
  sessions: Array<{
    id: string;
    profile: OxyProfile;
    lastActive: Date;
  }>;
}

/**
 * Response from the session switching endpoint
 */
interface SwitchSessionResponse {
  user: User;
  accessToken: string;
  refreshToken: string;
}

/**
 * Client library for OxyHQ platform services
 */
export class OxyClient {
  private baseUrl: string;
  private profileCache: Map<string, { profile: OxyProfile, timestamp: number }> = new Map();
  private readonly PROFILE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private pendingRequests: Map<string, Promise<any>> = new Map();
  
  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || OXY_API_CONFIG.CLOUD_URL;
  }
  
  /**
   * Get metadata for multiple files by their IDs
   * @param mediaIds Array of file IDs
   * @returns Promise resolving to array of file metadata objects
   */
  async getFilesData(mediaIds: string[]): Promise<any[]> {
    if (!mediaIds || mediaIds.length === 0) return [];
    
    try {
      const validIds = mediaIds.filter(Boolean);
      if (validIds.length === 0) return [];
      
      const cacheKey = `files_data_${validIds.join(",")}`;
      
      // Return existing promise if request is already in progress
      if (this.pendingRequests.has(cacheKey)) {
        return this.pendingRequests.get(cacheKey);
      }
      
      // Create new request promise
      const requestPromise = new Promise<any[]>(async (resolve, reject) => {
        try {
          const response = await apiService.get(`/files/data/${validIds.join(",")}`, { 
            useCache: true,
            cacheTTL: 2 * 60 * 1000 // 2 minutes cache
          });
          resolve(Array.isArray(response.data) ? response.data : []);
        } catch (error) {
          errorHandler.handleError(error, {
            context: 'Error fetching files data',
            showToast: false
          });
          resolve([]); // Resolve with empty array instead of rejecting
        } finally {
          // Remove from pending requests
          this.pendingRequests.delete(cacheKey);
        }
      });
      
      // Store the pending request
      this.pendingRequests.set(cacheKey, requestPromise);
      
      return requestPromise;
    } catch (error) {
      errorHandler.handleError(error, {
        context: 'Error in getFilesData',
        showToast: false
      });
      return [];
    }
  }
  
  /**
   * Get the URL for accessing a file
   * @param fileId ID of the file
   * @returns Promise resolving to the file URL
   */
  async getFileUrl(fileId: string): Promise<string> {
    if (!fileId) throw new Error('File ID is required');
    return `${this.baseUrl}/${fileId}`;
  }
  
  /**
   * Get a user profile by ID
   * @param userId ID of the user
   * @returns Promise resolving to the user profile
   */
  async getProfile(userId: string): Promise<OxyProfile> {
    if (!userId) throw new Error('User ID is required');
    
    try {
      // Check cache first
      const cachedProfile = this.profileCache.get(userId);
      if (cachedProfile && (Date.now() - cachedProfile.timestamp) < this.PROFILE_CACHE_TTL) {
        return cachedProfile.profile;
      }
      
      const cacheKey = `profile_${userId}`;
      
      // Return existing promise if request is already in progress
      if (this.pendingRequests.has(cacheKey)) {
        return this.pendingRequests.get(cacheKey);
      }
      
      // Create new request promise
      const requestPromise = new Promise<OxyProfile>(async (resolve, reject) => {
        try {
          const response = await apiService.get<OxyProfile>(
            ENDPOINTS.USERS.PROFILE(userId),
            { useCache: true }
          );
          
          // Update cache
          this.profileCache.set(userId, {
            profile: response.data,
            timestamp: Date.now()
          });
          
          resolve(response.data);
        } catch (error) {
          errorHandler.handleError(error, {
            context: 'Error fetching profile',
            fallbackMessage: ERROR_MESSAGES.DEFAULT
          });
          reject(new Error(ERROR_MESSAGES.DEFAULT));
        } finally {
          // Remove from pending requests
          this.pendingRequests.delete(cacheKey);
        }
      });
      
      // Store the pending request
      this.pendingRequests.set(cacheKey, requestPromise);
      
      return requestPromise;
    } catch (error) {
      errorHandler.handleError(error, {
        context: 'Error in getProfile',
        fallbackMessage: ERROR_MESSAGES.DEFAULT
      });
      throw new Error(ERROR_MESSAGES.DEFAULT);
    }
  }
  
  /**
   * Get a user profile by username
   * @param username Username of the user
   * @returns Promise resolving to the user profile
   */
  async getProfileByUsername(username: string): Promise<OxyProfile> {
    if (!username) throw new Error('Username is required');
    
    try {
      const cacheKey = `profile_username_${username}`;
      
      // Return existing promise if request is already in progress
      if (this.pendingRequests.has(cacheKey)) {
        return this.pendingRequests.get(cacheKey);
      }
      
      // Create new request promise
      const requestPromise = new Promise<OxyProfile>(async (resolve, reject) => {
        try {
          const response = await apiService.get<OxyProfile>(
            `/profiles/username/${username}`,
            { useCache: true }
          );
          
          // Also cache by user ID for future lookups
          if (response.data.userID) {
            this.profileCache.set(response.data.userID, {
              profile: response.data,
              timestamp: Date.now()
            });
          }
          
          resolve(response.data);
        } catch (error) {
          errorHandler.handleError(error, {
            context: 'Error fetching profile by username',
            fallbackMessage: ERROR_MESSAGES.DEFAULT
          });
          reject(new Error(ERROR_MESSAGES.DEFAULT));
        } finally {
          // Remove from pending requests
          this.pendingRequests.delete(cacheKey);
        }
      });
      
      // Store the pending request
      this.pendingRequests.set(cacheKey, requestPromise);
      
      return requestPromise;
    } catch (error) {
      errorHandler.handleError(error, {
        context: 'Error in getProfileByUsername',
        fallbackMessage: ERROR_MESSAGES.DEFAULT
      });
      throw new Error(ERROR_MESSAGES.DEFAULT);
    }
  }
  
  /**
   * Get all user sessions
   * @returns Promise resolving to session data
   */
  async getSessions(): Promise<SessionResponse> {
    try {
      // Get the current user ID
      const userId = await getData(STORAGE_KEYS.USER_ID);
      
      if (!userId) {
        console.warn('No user ID available when fetching sessions');
        // Return empty sessions if there's no user ID
        return { sessions: [] };
      }

      // First try to get from API with the user ID as a query parameter
      const response = await apiService.get<SessionResponse>(
        ENDPOINTS.USERS.SESSIONS,
        { 
          useCache: true,
          params: { userId } // Include userId as a parameter
        }
      );
      
      // Store the sessions locally for offline access
      await storeData(STORAGE_KEYS.SESSIONS, response.data.sessions);
      
      return response.data;
    } catch (error) {
      errorHandler.handleError(error, {
        context: 'Error fetching sessions',
        showToast: false
      });
      
      // Fallback to locally stored sessions
      const localSessions = await getData<SessionResponse['sessions']>(STORAGE_KEYS.SESSIONS);
      if (localSessions) {
        return { sessions: localSessions };
      }
      
      return { sessions: [] }; // Return empty sessions array if nothing found
    }
  }
  
  /**
   * Switch to a different user session
   * @param userId ID of the user to switch to
   * @returns Promise resolving to session switch response
   */
  async switchSession(userId: string): Promise<SwitchSessionResponse> {
    if (!userId) throw new Error('User ID is required');
    
    try {
      const response = await apiService.post<SwitchSessionResponse>(
        '/auth/switch-session', 
        { userId }
      );
      return response.data;
    } catch (error) {
      errorHandler.handleError(error, {
        context: 'Error switching session',
        fallbackMessage: ERROR_MESSAGES.DEFAULT
      });
      throw new Error(ERROR_MESSAGES.DEFAULT);
    }
  }

  /**
   * Get recommended profiles to follow
   * @param limit Optional number of recommendations to return
   * @returns Promise resolving to array of recommended profiles
   */
  async getRecommendations(limit?: number): Promise<OxyProfile[]> {
    try {
      const params = limit ? { limit: limit.toString() } : undefined;
      const response = await apiService.get<OxyProfile[]>(
        '/profiles/recommendations', 
        { 
          params,
          useCache: true,
          cacheTTL: 15 * 60 * 1000 // 15 minutes cache for recommendations
        }
      );
      return response.data;
    } catch (error) {
      errorHandler.handleError(error, {
        context: 'Error fetching recommendations',
        showToast: false
      });
      return []; // Return empty array instead of throwing
    }
  }
  
  /**
   * Clear profile cache
   * @param userId Optional user ID to clear specific cache entry
   */
  clearProfileCache(userId?: string): void {
    if (userId) {
      this.profileCache.delete(userId);
    } else {
      this.profileCache.clear();
    }
  }
}

// Export singleton instance
export const oxyClient = new OxyClient();