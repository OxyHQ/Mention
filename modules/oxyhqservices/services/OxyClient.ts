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
      
      const response = await apiService.get(`/files/data/${validIds.join(",")}`);
      return Array.isArray(response.data) ? response.data : [];
    } catch (error) {
      console.error('Error fetching files data:', error);
      throw error;
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
      const response = await apiService.get<OxyProfile>(ENDPOINTS.USERS.PROFILE(userId));
      return response.data;
    } catch (error) {
      console.error('Error fetching profile:', error);
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
      const response = await apiService.get<OxyProfile>(`/profiles/username/${username}`);
      return response.data;
    } catch (error) {
      console.error('Error fetching profile by username:', error);
      throw new Error(ERROR_MESSAGES.DEFAULT);
    }
  }
  
  /**
   * Get all user sessions
   * @returns Promise resolving to session data
   */
  async getSessions(): Promise<SessionResponse> {
    try {
      // First try to get from API
      const response = await apiService.get<SessionResponse>(ENDPOINTS.USERS.SESSIONS);
      
      // Store the sessions locally for offline access
      await storeData(STORAGE_KEYS.SESSIONS, response.data.sessions);
      
      return response.data;
    } catch (error) {
      console.error('Error fetching sessions:', error);
      
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
      console.error('Error switching session:', error);
      throw new Error(ERROR_MESSAGES.DEFAULT);
    }
  }
}

// Export singleton instance
export const oxyClient = new OxyClient();