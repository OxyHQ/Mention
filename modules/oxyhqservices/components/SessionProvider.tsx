import { createContext, useReducer, useEffect, ReactNode, useCallback } from 'react';
import { authService } from '../services/auth.service';
import { userService } from '../services/user.service';
import { profileService } from '../services/profile.service';
import { logger } from '@/utils/logger';
import { getData, storeData, getSecureData, cleanupLegacyStorage } from '../utils/storage';
import type { User } from '../services/auth.service';
import type { OxyProfile } from '../types';
import type { UserSession } from '../services/user.service';

interface SessionState {
  userId: string | null;
  loading: boolean;
  error: string | null;
  user: User | null;
  sessions: UserSession[];
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
  sessions: []
};

type Action =
  | { type: 'LOGIN'; payload: { userId: string; user: User | null } }
  | { type: 'LOGOUT' }
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'SET_ERROR'; payload: string }
  | { type: 'SET_SESSIONS'; payload: UserSession[] }
  | { type: 'SET_PROFILE'; payload: { profile: OxyProfile } };

const sessionReducer = (state: SessionState, action: Action): SessionState => {
  switch (action.type) {
    case 'LOGIN':
      return {
        ...state,
        userId: action.payload.userId,
        user: action.payload.user,
        error: null
      };
    case 'LOGOUT':
      return {
        ...state,
        userId: null,
        user: null,
        sessions: [],
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
        // Update existing session with profile
        updatedSessions[existingSessionIndex] = {
          ...updatedSessions[existingSessionIndex],
          profile: action.payload.profile
        };
      } else {
        // Add new session
        updatedSessions.push({
          id: action.payload.profile.userID,
          profile: action.payload.profile
        });
      }
      
      return { ...state, sessions: updatedSessions };
    }
    default:
      return state;
  }
};

export const SessionContext = createContext<SessionContextType | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(sessionReducer, initialState);

  // Refresh check interval (every minute)
  const TOKEN_REFRESH_INTERVAL = 60 * 1000;

  const refreshTokenIfNeeded = useCallback(async () => {
    try {
      const accessToken = await getSecureData<string>('accessToken');
      if (!accessToken) return false;

      // Check if token needs refresh using authService
      if (authService.shouldRefreshToken(accessToken)) {
        const result = await authService.refreshToken();
        return !!result;
      }
      
      return true;
    } catch (error) {
      logger.error('Token refresh check failed:', error);
      return false;
    }
  }, []);

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
        // Clean up legacy storage items
        await cleanupLegacyStorage();

        // Get token and userId from storage
        const [accessToken, userId] = await Promise.all([
          getSecureData('accessToken'),
          getData('userId')
        ]);

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
      try {
        await authService.login({ username, password });
      } catch (error: any) {
        if (error?.details) {
          throw error; // Preserve validation error structure
        }
        throw new Error(error?.message || 'Login failed');
      }

      // Get the userId after login
      const userId = await authService.getCurrentSessionUserId();
      if (!userId) {
        throw new Error('Login failed: Unable to get user ID');
      }

      const profile = await profileService.getProfileById(userId);
      
      // Update state with user info
      dispatch({ 
        type: 'LOGIN', 
        payload: { 
          userId,
          user: { 
            id: userId,
            username: username,  // Use the username from login attempt
            email: ''  // We'll update this when we get the profile
          }
        } 
      });

      // Set profile after login
      dispatch({ 
        type: 'SET_PROFILE', 
        payload: { profile }
      });
      
      // Refresh sessions
      const response = await userService.getSessions();
      dispatch({ type: 'SET_SESSIONS', payload: response.data || [] });

    } catch (error: any) {
      logger.error('Login error:', error);
      if (error?.details) {
        throw error; // Re-throw validation errors with details
      }
      dispatch({ type: 'SET_ERROR', payload: error?.message || 'Login failed' });
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
