import React, { createContext, useReducer, useEffect, ReactNode, useCallback, useState } from 'react';
import { authService } from '../services/auth.service';
import { userService } from '../services/user.service';
import { profileService } from '../services/profile.service';
import { getData, storeData, getSecureData, storeSecureData, cleanupLegacyStorage } from '../utils/storage';
import type { User } from '../services/auth.service';
import type { OxyProfile } from '../types';
import type { UserSession } from '../services/user.service';
import { STORAGE_KEYS } from '../constants';
import { toast } from 'sonner';

// Simple logger implementation
const logger = {
  info: (message: string, ...args: any[]) => console.info(`[INFO] ${message}`, ...args),
  error: (message: string, ...args: any[]) => console.error(`[ERROR] ${message}`, ...args),
  warn: (message: string, ...args: any[]) => console.warn(`[WARN] ${message}`, ...args),
  debug: (message: string, ...args: any[]) => console.debug(`[DEBUG] ${message}`, ...args)
};

interface SessionState {
  userId: string | null;
  loading: boolean;
  error: string | null;
  user: User | null;
  sessions: UserSession[];
  lastActivity: number;
}

interface SessionContextType {
  state: SessionState;
  loginUser: (username: string, password: string) => Promise<void>;
  logoutUser: () => Promise<boolean>;
  getCurrentUserId: () => string | null;
  switchSession: (userId: string) => Promise<void>;
  refreshTokenIfNeeded: () => Promise<boolean>;
  sessions: UserSession[];
  isAuthenticated: boolean;
}

const initialState: SessionState = {
  userId: null,
  loading: true,
  error: null,
  user: null,
  sessions: [],
  lastActivity: Date.now()
};

type Action =
  | { type: 'LOGIN'; payload: { userId: string; user: User | null } }
  | { type: 'LOGOUT' }
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'SET_ERROR'; payload: string }
  | { type: 'CLEAR_ERROR' }
  | { type: 'SET_SESSIONS'; payload: UserSession[] }
  | { type: 'SET_PROFILE'; payload: { profile: OxyProfile } }
  | { type: 'UPDATE_ACTIVITY' };

const sessionReducer = (state: SessionState, action: Action): SessionState => {
  switch (action.type) {
    case 'LOGIN':
      return {
        ...state,
        userId: action.payload.userId,
        user: action.payload.user,
        error: null,
        lastActivity: Date.now()
      };
    case 'LOGOUT':
      return {
        ...state,
        userId: null,
        user: null,
        sessions: [],
        error: null,
        lastActivity: Date.now()
      };
    case 'SET_LOADING':
      return { ...state, loading: action.payload };
    case 'SET_ERROR':
      return { ...state, error: action.payload };
    case 'CLEAR_ERROR':
      return { ...state, error: null };
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
    case 'UPDATE_ACTIVITY':
      return { ...state, lastActivity: Date.now() };
    default:
      return state;
  }
};

export const SessionContext = createContext<SessionContextType | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(sessionReducer, initialState);
  const [initialized, setInitialized] = useState(false);

  // Refresh check interval (every minute)
  const TOKEN_REFRESH_INTERVAL = 60 * 1000;

  // Session timeout (30 minutes of inactivity)
  const SESSION_TIMEOUT = 30 * 60 * 1000;

  const refreshTokenIfNeeded = useCallback(async () => {
    try {
      const accessToken = await getSecureData<string>(STORAGE_KEYS.ACCESS_TOKEN);
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

  // Update activity timestamp on user interaction
  const updateActivity = useCallback(() => {
    dispatch({ type: 'UPDATE_ACTIVITY' });
  }, []);

  // Check for session timeout
  useEffect(() => {
    if (!state.userId) return;

    const checkSessionTimeout = () => {
      const now = Date.now();
      const timeSinceLastActivity = now - state.lastActivity;

      if (timeSinceLastActivity > SESSION_TIMEOUT) {
        logger.warn('Session timeout due to inactivity');
        toast.warning('Your session has expired due to inactivity');
        logoutUser();
      }
    };

    const intervalId = setInterval(checkSessionTimeout, 60 * 1000); // Check every minute

    return () => clearInterval(intervalId);
  }, [state.userId, state.lastActivity]);

  // Set up activity tracking
  useEffect(() => {
    if (!state.userId) return;

    const activityEvents = ['mousedown', 'keydown', 'touchstart', 'scroll'];

    const handleUserActivity = () => {
      updateActivity();
    };

    activityEvents.forEach(event => {
      window.addEventListener(event, handleUserActivity);
    });

    return () => {
      activityEvents.forEach(event => {
        window.removeEventListener(event, handleUserActivity);
      });
    };
  }, [state.userId, updateActivity]);

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
        dispatch({ type: 'SET_LOADING', payload: true });
        const response = await userService.getSessions();
        dispatch({ type: 'SET_SESSIONS', payload: response.data || [] });
      } catch (error) {
        logger.error('Failed to load sessions:', error);
      } finally {
        dispatch({ type: 'SET_LOADING', payload: false });
      }
    };

    if (state.userId && initialized) {
      loadSessions();
    }
  }, [state.userId, initialized]);

  useEffect(() => {
    const initializeSession = async () => {
      dispatch({ type: 'SET_LOADING', payload: true });
      try {
        // Clean up legacy storage items
        await cleanupLegacyStorage();

        // Get token and userId from storage
        const [accessToken, userId] = await Promise.all([
          getSecureData(STORAGE_KEYS.ACCESS_TOKEN),
          getData(STORAGE_KEYS.USER_ID)
        ]);

        const isValid = await authService.validateCurrentSession();

        if (isValid && accessToken && userId) {
          try {
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

            logger.info('Session restored successfully');
          } catch (profileError) {
            logger.error('Error fetching profile during session initialization:', profileError);
            // Continue with basic session even if profile fetch fails
            dispatch({
              type: 'LOGIN',
              payload: {
                userId: userId as string,
                user: { id: userId as string } as User
              }
            });
          }
        } else {
          dispatch({ type: 'LOGOUT' });
        }
      } catch (error) {
        logger.error('Session initialization error:', error);
        dispatch({ type: 'SET_ERROR', payload: 'Session initialization failed' });
        dispatch({ type: 'LOGOUT' });
      } finally {
        dispatch({ type: 'SET_LOADING', payload: false });
        setInitialized(true);
      }
    };

    initializeSession();
  }, []);

  const loginUser = async (username: string, password: string) => {
    try {
      dispatch({ type: 'SET_LOADING', payload: true });
      dispatch({ type: 'CLEAR_ERROR' });

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

      try {
        const profile = await profileService.getProfileById(userId);

        // Update state with user info
        dispatch({
          type: 'LOGIN',
          payload: {
            userId,
            user: {
              id: userId,
              username: username,
              email: ''
            }
          }
        });

        // Set profile after login
        dispatch({
          type: 'SET_PROFILE',
          payload: { profile }
        });
      } catch (profileError) {
        logger.error('Error fetching profile after login:', profileError);
        // Continue with basic user info even if profile fetch fails
        dispatch({
          type: 'LOGIN',
          payload: {
            userId,
            user: {
              id: userId,
              username: username,
              email: ''
            }
          }
        });
      }

      // Refresh sessions
      try {
        const response = await userService.getSessions();
        dispatch({ type: 'SET_SESSIONS', payload: response.data || [] });
      } catch (sessionsError) {
        logger.error('Error fetching sessions after login:', sessionsError);
      }

      toast.success('Logged in successfully');
      updateActivity();

    } catch (error: any) {
      logger.error('Login error:', error);
      if (error?.details) {
        throw error; // Re-throw validation errors with details
      }
      dispatch({ type: 'SET_ERROR', payload: error?.message || 'Login failed' });
      toast.error(error?.message || 'Login failed');
      throw error;
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  };

  const logoutUser = async () => {
    try {
      dispatch({ type: 'SET_LOADING', payload: true });

      const currentUserId = state.userId;
      await authService.logout();

      if (currentUserId) {
        await userService.removeUserSession(currentUserId);
      }

      dispatch({ type: 'LOGOUT' });
      toast.success('Logged out successfully');

      return true;
    } catch (error) {
      logger.error('Logout error:', error);
      toast.error('Error during logout');
      return false;
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  };

  const switchSession = async (userId: string) => {
    try {
      dispatch({ type: 'SET_LOADING', payload: true });
      dispatch({ type: 'CLEAR_ERROR' });

      const session = state.sessions.find(s => s.id === userId);
      if (!session) {
        throw new Error('Session not found');
      }

      // Use the existing user session instead of activating it
      // This assumes the session already has valid tokens

      // Get fresh profile data
      const profile = await profileService.getProfileById(userId);

      dispatch({
        type: 'LOGIN',
        payload: {
          userId,
          user: { id: userId } as User
        }
      });

      dispatch({
        type: 'SET_PROFILE',
        payload: { profile }
      });

      toast.success('Switched account successfully');
      updateActivity();

    } catch (error: any) {
      logger.error('Session switch error:', error);
      dispatch({ type: 'SET_ERROR', payload: error?.message || 'Failed to switch session' });
      toast.error(error?.message || 'Failed to switch account');
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  };

  const getCurrentUserId = useCallback(() => {
    return state.userId;
  }, [state.userId]);

  const contextValue: SessionContextType = {
    state,
    loginUser,
    logoutUser,
    getCurrentUserId,
    switchSession,
    refreshTokenIfNeeded,
    sessions: state.sessions,
    isAuthenticated: !!state.userId && !state.loading
  };

  return (
    <SessionContext.Provider value={contextValue}>
      {children}
    </SessionContext.Provider>
  );
}
