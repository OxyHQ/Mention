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

// The session management is refactored to rely solely on oxyhqservices.
// Session tokens and session IDs are handled by the backend and stored in the database.
// User details (name, username, email, avatar) are fetched dynamically using profileService.

interface SessionState {
  userId: string | null;
  loading: boolean;
  error: string | null;
}

interface SessionContextType {
  state: SessionState;
  loginUser: (username: string, password: string) => Promise<void>;
  logoutUser: () => Promise<void>;
  getCurrentUserId: () => string | null;
  switchSession: (userId: string) => Promise<void>;
}

const initialState: SessionState = {
  userId: null,
  loading: true,
  error: null,
};

type Action =
  | { type: 'LOGIN'; payload: string }  // payload is userId
  | { type: 'LOGOUT' }
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'SET_ERROR'; payload: string };

const sessionReducer = (state: SessionState, action: Action): SessionState => {
  switch (action.type) {
    case 'LOGIN':
      return { ...state, userId: action.payload, error: null };
    case 'LOGOUT':
      return { ...state, userId: null, error: null };
    case 'SET_LOADING':
      return { ...state, loading: action.payload };
    case 'SET_ERROR':
      return { ...state, error: action.payload };
    default:
      return state;
  }
};

export const SessionContext = createContext<SessionContextType | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(sessionReducer, initialState);
  const [activeProfile, setActiveProfile] = useState<OxyProfile | null>(null);
  const reduxDispatch = useDispatch();

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
            dispatch({ type: 'LOGIN', payload: currentUserId });
            reduxDispatch(login({ user: { id: currentUserId } as User, accessToken: 'secured' }));
            // Dynamically fetch fresh user profile
            const profile = await profileService.getProfileById(currentUserId);
            reduxDispatch(setProfile(profile));
            setActiveProfile(profile);
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
      dispatch({ type: 'LOGIN', payload: user.id });
      reduxDispatch(login({ user: { id: user.id } as User, accessToken }));
      // Dynamically fetch user profile details
      const profile = await profileService.getProfileById(user.id);
      reduxDispatch(setProfile(profile));
      setActiveProfile(profile);
      logger.info(`Login successful for user: ${user.id}`);
    } catch (error) {
      logger.error('Login error:', error);
      dispatch({ type: 'SET_ERROR', payload: 'Login failed' });
      throw error;
    }
  };

  const logoutUser = async () => {
    try {
      await authService.logout();
      dispatch({ type: 'LOGOUT' });
      reduxDispatch(logout());
      reduxDispatch(clearProfile());
      setActiveProfile(null);
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
      dispatch({ type: 'LOGIN', payload: profile.userID });
      reduxDispatch(login({ user: { id: profile.userID } as User, accessToken: 'secured' }));
      reduxDispatch(setProfile(profile));
      setActiveProfile(profile);
      logger.info(`Session switched successfully to user ${profile.userID}`);
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
