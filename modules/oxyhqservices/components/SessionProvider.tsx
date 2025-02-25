import React, { createContext, useReducer, useEffect, ReactNode } from 'react';
import { setProfile, clearProfile } from '@/modules/oxyhqservices/reducers/profileReducer';
import { authService } from '../services/auth.service';
import { userService } from '../services/user.service';
import { profileService } from '../services/profile.service';
import { logger } from '@/utils/logger';
import type { User } from '../services/auth.service';
import type { OxyProfile } from '../types';

interface SessionState {
  userId: string | null;
  loading: boolean;
  error: string | null;
  user: User | null;
  sessions: UserSession[];
}

interface UserSession {
  id: string;
  accessToken: string;
  refreshToken?: string;
  lastRefresh: number;
  profile?: OxyProfile;
}

interface SessionContextType {
  state: SessionState;
  loginUser: (username: string, password: string) => Promise<void>;
  logoutUser: () => Promise<void>;
  getCurrentUserId: () => string | null;
  switchSession: (userId: string) => Promise<void>;
  sessions: UserSession[];
}

const initialState: SessionState = {
  userId: null,
  loading: true,
  error: null,
  user: null,
  sessions: [],
};

type Action =
  | { type: 'LOGIN'; payload: { userId: string; user: User | null } }
  | { type: 'LOGOUT' }
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'SET_ERROR'; payload: string }
  | { type: 'SET_SESSIONS'; payload: UserSession[] }
  | { type: 'SET_PROFILE'; payload: OxyProfile };

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
    case 'SET_PROFILE':
      return { ...state, sessions: [...state.sessions, { id: action.payload.userID, accessToken: 'secured', lastRefresh: Date.now() }] };
    default:
      return state;
  }
};

export const SessionContext = createContext<SessionContextType | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(sessionReducer, initialState);

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

  // On initialization, validate session using oxyhqservices
  useEffect(() => {
    const initializeSession = async () => {
      dispatch({ type: 'SET_LOADING', payload: true });
      try {
        const isValid = await authService.validateCurrentSession();
        if (isValid) {
          const currentUserId = await authService.getCurrentSessionUserId();
          if (currentUserId) {
            const profile = await profileService.getProfileById(currentUserId);
            dispatch({ type: 'LOGIN', payload: { userId: currentUserId, user: { id: currentUserId } as User } });
            dispatch({ type: 'SET_PROFILE', payload: profile });
          } else {
            dispatch({ type: 'LOGOUT' });
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
      }
    };

    initializeSession();
  }, []);

  const loginUser = async (username: string, password: string) => {
    try {
      logger.info(`Login attempt for user: ${username}`);
      const { user, accessToken } = await authService.login(username, password);
      if (!user || !user.id) {
        throw new Error('Login failed: Missing user session data');
      }

      const profile = await profileService.getProfileById(user.id);
      await userService.addUserSession(user, accessToken);

      const response = await userService.getSessions();
      dispatch({ type: 'SET_SESSIONS', payload: response.data || [] });
      dispatch({ type: 'LOGIN', payload: { userId: user.id, user } });
      dispatch({ type: 'SET_PROFILE', payload: profile });
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

      const { user, accessToken } = await userService.refreshUserData(userId);
      await userService.addUserSession(user, accessToken);

      const response = await userService.getSessions();
      dispatch({ type: 'SET_SESSIONS', payload: response.data || [] });
      dispatch({ type: 'LOGIN', payload: { userId: profile.userID, user } });
      dispatch({ type: 'SET_PROFILE', payload: profile });
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
