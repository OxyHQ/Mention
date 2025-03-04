import { createContext, useReducer, useEffect, ReactNode, useCallback } from 'react';
import { authService } from '../services/auth.service';
import { userService } from '../services/user.service';
import { profileService } from '../services/profile.service';
import { logger } from '@/utils/logger';
import { getData, storeData, getSecureData } from '../utils/storage';
import type { User } from '../services/auth.service';
import type { OxyProfile } from '../types';

interface SessionState {
  userId: string | null;
  loading: boolean;
  error: string | null;
  user: User | null;
  sessions: UserSession[];
  lastTokenRefresh: number;
}

interface UserSession {
  id: string;
  lastRefresh: number;
  profile?: OxyProfile;
}

interface SessionContextType {
  state: SessionState;
  loginUser: (username: string, password: string) => Promise<void>;
  logoutUser: () => Promise<void>;
  getCurrentUserId: () => string | null;
  switchSession: (userId: string) => Promise<void>;
  refreshTokenIfNeeded: () => Promise<boolean>;
  sessions: UserSession[];
}

const initialState: SessionState = {
  userId: null,
  loading: true,
  error: null,
  user: null,
  sessions: [],
  lastTokenRefresh: 0
};

type Action =
  | { type: 'LOGIN'; payload: { userId: string; user: User | null } }
  | { type: 'LOGOUT' }
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'SET_ERROR'; payload: string }
  | { type: 'SET_SESSIONS'; payload: UserSession[] }
  | { type: 'SET_PROFILE'; payload: { profile: OxyProfile } }
  | { type: 'TOKEN_REFRESHED'; payload: { timestamp: number } };

const sessionReducer = (state: SessionState, action: Action): SessionState => {
  switch (action.type) {
    case 'LOGIN':
      return {
        ...state,
        userId: action.payload.userId,
        user: action.payload.user,
        lastTokenRefresh: Date.now(),
        error: null
      };
    case 'LOGOUT':
      return {
        ...state,
        userId: null,
        user: null,
        sessions: [],
        lastTokenRefresh: 0,
        error: null
      };
    case 'SET_LOADING':
      return { ...state, loading: action.payload };
    case 'SET_ERROR':
      return { ...state, error: action.payload };
    case 'SET_SESSIONS':
      return { ...state, sessions: action.payload };
    case 'SET_PROFILE': {
      const updatedSessions = [...state.sessions];
      const existingSessionIndex = updatedSessions.findIndex(s => s.id === action.payload.profile.userID);
      
      if (existingSessionIndex >= 0) {
        // Update existing session
        updatedSessions[existingSessionIndex] = {
          ...updatedSessions[existingSessionIndex],
          lastRefresh: Date.now(),
          profile: action.payload.profile
        };
      } else {
        // Add new session
        updatedSessions.push({
          id: action.payload.profile.userID,
          lastRefresh: Date.now(),
          profile: action.payload.profile
        });
      }
      
      return { ...state, sessions: updatedSessions };
    }
    case 'TOKEN_REFRESHED':
      return { 
        ...state,
        lastTokenRefresh: action.payload.timestamp
      };
    default:
      return state;
  }
};

export const SessionContext = createContext<SessionContextType | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(sessionReducer, initialState);

  // Token refresh check interval (every minute)
  const TOKEN_REFRESH_INTERVAL = 60 * 1000; 
  
  const refreshTokenIfNeeded = useCallback(async () => {
    // Check if token refresh is needed based on last refresh time
    const timeSinceLastRefresh = Date.now() - state.lastTokenRefresh;
    
    if (timeSinceLastRefresh < TOKEN_REFRESH_INTERVAL) {
      return false; // Too soon to refresh
    }

    try {
      const result = await authService.refreshToken();
      if (!result) return false;
      
      // Update timestamp in the state
      dispatch({ 
        type: 'TOKEN_REFRESHED', 
        payload: { 
          timestamp: Date.now() 
        } 
      });
      
      // Also store timestamp in storage for persistence
      await storeData('lastTokenRefresh', Date.now());
      
      return true;
    } catch (error) {
      logger.error('Token refresh failed:', error);
      return false;
    }
  }, [state.lastTokenRefresh]);

  useEffect(() => {
    // Set up periodic token refresh
    const refreshInterval = setInterval(async () => {
      if (state.userId) {
        await refreshTokenIfNeeded();
      }
    }, TOKEN_REFRESH_INTERVAL);

    return () => clearInterval(refreshInterval);
  }, [refreshTokenIfNeeded, state.userId]);

  useEffect(() => {
    const loadSessions = async () => {
      try {
        const response = await userService.getSessions();
        dispatch({ type: 'SET_SESSIONS', payload: response.data || [] });
      } catch (error) {
        logger.error('Failed to load sessions:', error);
      }
    };
    
    if (state.userId) {
      loadSessions();
    }
  }, [state.userId]);

  useEffect(() => {
    const initializeSession = async () => {
      dispatch({ type: 'SET_LOADING', payload: true });
      try {
        // Get token and userId from storage
        const [accessToken, userId, lastRefreshTime] = await Promise.all([
          getSecureData('accessToken'),
          getData('userId'),
          getData('lastTokenRefresh')
        ]);
        
        // Set last refresh time if available
        if (lastRefreshTime) {
          dispatch({ 
            type: 'TOKEN_REFRESHED', 
            payload: { timestamp: lastRefreshTime as number } 
          });
        }

        const isValid = await authService.validateCurrentSession();
        
        if (isValid && accessToken && userId) {
          const profile = await profileService.getProfileById(userId as string);
          
          dispatch({ 
            type: 'LOGIN', 
            payload: { 
              userId: userId as string, 
              user: { id: userId as string } as User
            } 
          });
          
          dispatch({ 
            type: 'SET_PROFILE', 
            payload: { profile } 
          });
        } else {
          dispatch({ type: 'LOGOUT' });
        }
      } catch (error) {
        logger.error('Session initialization error:', error);
        dispatch({ type: 'SET_ERROR', payload: 'Session initialization failed' });
        dispatch({ type: 'LOGOUT' });
      } finally {
        dispatch({ type: 'SET_LOADING', payload: false });
      }
    };
    
    initializeSession();
  }, []);

  const loginUser = async (username: string, password: string) => {
    try {
      logger.info(`Login attempt for user: ${username}`);
      const { user, accessToken, refreshToken } = await authService.login(username, password);
      
      if (!user || !user.id) {
        throw new Error('Login failed: Missing user session data');
      }
      
      const profile = await profileService.getProfileById(user.id);
      
      // Store last token refresh time
      await storeData('lastTokenRefresh', Date.now());
      
      // Add user session
      await userService.addUserSession(user, accessToken, refreshToken);
      const response = await userService.getSessions();
      
      dispatch({ type: 'SET_SESSIONS', payload: response.data || [] });
      dispatch({ 
        type: 'LOGIN', 
        payload: { 
          userId: user.id, 
          user
        } 
      });
      
      dispatch({ 
        type: 'SET_PROFILE', 
        payload: { profile }
      });
    } catch (error) {
      logger.error('Login error:', error);
      dispatch({ type: 'SET_ERROR', payload: 'Login failed' });
      throw error;
    }
  };

  const logoutUser = async () => {
    try {
      const currentUserId = state.userId;
      await authService.logout();
      
      if (currentUserId) {
        await userService.removeUserSession(currentUserId);
      }
      
      dispatch({ type: 'LOGOUT' });
    } catch (error) {
      logger.error('Logout error:', error);
      throw error;
    }
  };

  const switchSession = async (userId: string) => {
    try {
      const profile = await profileService.getProfileById(userId);
      
      if (!profile || !profile.userID) {
        throw new Error('Session switch failed: Invalid profile data');
      }
      
      const { user, accessToken, refreshToken } = await userService.refreshUserData(userId);
      
      // Store last token refresh time
      await storeData('lastTokenRefresh', Date.now());
      
      // Add user session with updated tokens
      await userService.addUserSession(user, accessToken, refreshToken);
      const response = await userService.getSessions();
      
      dispatch({ type: 'SET_SESSIONS', payload: response.data || [] });
      dispatch({ 
        type: 'LOGIN', 
        payload: { 
          userId: profile.userID, 
          user
        } 
      });
      
      dispatch({ 
        type: 'SET_PROFILE', 
        payload: { profile }
      });
    } catch (error) {
      logger.error('Session switch error:', error);
      throw error;
    }
  };

  const getCurrentUserId = () => state.userId;

  const contextValue: SessionContextType = {
    state,
    loginUser,
    logoutUser,
    getCurrentUserId,
    switchSession,
    refreshTokenIfNeeded,
    sessions: state.sessions,
  };

  if (state.loading) {
    return null;
  }

  return (
    <SessionContext.Provider value={contextValue}>
      {children}
    </SessionContext.Provider>
  );
}
