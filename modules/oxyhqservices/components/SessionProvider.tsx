import React, { createContext, useReducer, useEffect, ReactNode, useState } from 'react';
import { useDispatch } from 'react-redux';
import { login, logout, loadSession } from '@/store/reducers/sessionReducer';
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
  username: string;
  name?: {
    first?: string;
    last?: string;
  };
  avatar?: string;
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
  | { type: 'SET_SESSIONS'; payload: UserSession[] };

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
    default:
      return state;
  }
};

export const SessionContext = createContext<SessionContextType | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(sessionReducer, initialState);
  const reduxDispatch = useDispatch();

  useEffect(() => {
    const loadSessions = async () => {
      try {
        // Fetch sessions from the backend
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
        // Validate current session via oxyhqservices. This call only validates the token stored in memory (managed by authService).
        const isValid = await authService.validateCurrentSession();
        if (isValid) {
          // Assume authService exposes the current session's user ID.
          const currentUserId = await authService.getCurrentSessionUserId();
          if (currentUserId) {
            dispatch({ type: 'LOGIN', payload: { userId: currentUserId, user: null } });
            reduxDispatch(login({ user: { id: currentUserId } as User, accessToken: 'secured' }));
            // Dynamically fetch fresh user profile
            const profile = await profileService.getProfileById(currentUserId);
            reduxDispatch(setProfile(profile));
          } else {
            dispatch({ type: 'LOGOUT' });
            reduxDispatch(logout());
          }
        } else {
          dispatch({ type: 'LOGOUT' });
          reduxDispatch(logout());
        }
      } catch (error) {
        logger.error('Session initialization error:', error);
        dispatch({ type: 'SET_ERROR', payload: 'Session initialization failed' });
        dispatch({ type: 'LOGOUT' });
        reduxDispatch(logout());
      } finally {
        dispatch({ type: 'SET_LOADING', payload: false });
      }
    };

    initializeSession();
  }, [reduxDispatch]);

  const loginUser = async (username: string, password: string) => {
    try {
      logger.info(`Login attempt for user: ${username}`);
      // Call oxyhqservices auth to login. This returns session tokens and user ID only.
      const { user, accessToken } = await authService.login(username, password);
      if (!user || !user.id) {
        throw new Error('Login failed: Missing user session data');
      }

      // Dynamically fetch user profile details
      const profile = await profileService.getProfileById(user.id);
      reduxDispatch(setProfile(profile));

      // Add user to sessions
      await userService.addUserSession({
        id: user.id,
        username: user.username,
        email: user.email,
        name: profile.name,
        avatar: profile.avatar
      });

      // Refresh sessions list and update state
      const response = await userService.getSessions();
      dispatch({ type: 'SET_SESSIONS', payload: response.data || [] });
      dispatch({ type: 'LOGIN', payload: { userId: user.id, user } });
      reduxDispatch(login({ user, accessToken }));
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
      reduxDispatch(logout());
      reduxDispatch(clearProfile());
    } catch (error) {
      logger.error('Logout error:', error);
      throw error;
    }
  };

  const switchSession = async (userId: string) => {
    try {
      // In this refactored version, switching sessions means fetching the profile for the given userId
      const profile = await profileService.getProfileById(userId);
      if (!profile || !profile.userID) {
        throw new Error('Session switch failed: Invalid profile data');
      }

      // Get user data
      const { user, accessToken } = await userService.refreshUserData(userId);

      // Add or update session
      await userService.addUserSession({
        id: user.id,
        username: user.username,
        email: user.email,
        name: profile.name,
        avatar: profile.avatar
      });

      // Refresh sessions list and update state
      const response = await userService.getSessions();
      dispatch({ type: 'SET_SESSIONS', payload: response.data || [] });
      dispatch({ type: 'LOGIN', payload: { userId: profile.userID, user } });
      reduxDispatch(login({ user, accessToken }));
      reduxDispatch(setProfile(profile));
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
    return null; // or a loading indicator
  }

  return (
    <SessionContext.Provider value={contextValue}>
      {children}
    </SessionContext.Provider>
  );
}
