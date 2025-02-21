import React, { createContext, useReducer, useEffect, ReactNode, useState } from 'react';
import { useDispatch } from 'react-redux';
import { login, logout, loadSession } from '@/store/reducers/sessionReducer';
import { setProfile, clearProfile } from '@/modules/oxyhqservices/reducers/profileReducer';
import { authService } from '../services/auth.service';
import { userService } from '../services/user.service';
import { storeData, getData } from '../utils/storage';
import { validateSession } from '@/utils/api';
import { logger } from '@/utils/logger';
import type { User } from '../services/auth.service';
import type { OxyProfile } from '../types';

// Add interface for stored session
interface StoredSession {
  isAuthenticated: boolean;
  user: User;
  accessToken: string;
  lastRefresh?: number;
}

interface SessionState {
  user: User | null;
  loading: boolean;
  error: string | null;
}

interface SessionContextType {
  state: SessionState;
  loginUser: (username: string, password: string) => Promise<void>;
  logoutUser: () => Promise<void>;
  getCurrentUser: () => User | null;
  switchSession: (userId: string) => Promise<void>;
  sessions: User[];
}

const initialState: SessionState = {
  user: null,
  loading: true,
  error: null,
};

type Action =
  | { type: 'LOGIN'; payload: User }
  | { type: 'LOGOUT' }
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'SET_ERROR'; payload: string };

const sessionReducer = (state: SessionState, action: Action): SessionState => {
  switch (action.type) {
    case 'LOGIN':
      return { ...state, user: action.payload, error: null };
    case 'LOGOUT':
      return { ...state, user: null, error: null };
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
  const [sessions, setSessions] = useState<User[]>([]);
  const reduxDispatch = useDispatch();

  useEffect(() => {
    const initializeSession = async () => {
      try {
        dispatch({ type: 'SET_LOADING', payload: true });
        
        // Load stored sessions first and validate them
        const storedSessions = await userService.getUserSessions();
        const validSessions = storedSessions.filter(session => 
          session && session.id && session.username
        );
        setSessions(validSessions);
        
        // First check if we have a stored session
        const storedSession = await getData<StoredSession>('session');
        if (storedSession?.accessToken && storedSession?.user) {
          // Validate the stored token
          try {
            const isValid = await validateSession();
            if (isValid) {
              // If token is valid, restore the session
              dispatch({ type: 'LOGIN', payload: storedSession.user });
              reduxDispatch(login({ user: storedSession.user, accessToken: storedSession.accessToken }));
              
              // Refresh user data in background
              const { profile } = await userService.refreshUserData(storedSession.user.id);
              if (profile) {
                reduxDispatch(setProfile(profile));
              }
            } else {
              // If token is invalid, try to refresh it
              const refreshToken = await getData('refreshToken');
              if (refreshToken) {
                try {
                  const { user, profile, accessToken } = await userService.refreshUserData(storedSession.user.id);
                  if (accessToken && user && user.username) {
                    await storeData('accessToken', accessToken);
                    dispatch({ type: 'LOGIN', payload: user });
                    reduxDispatch(login({ user, accessToken }));
                    reduxDispatch(setProfile(profile));
                  } else {
                    throw new Error('Invalid user data received during refresh');
                  }
                } catch (refreshError) {
                  logger.error('Failed to refresh session:', refreshError);
                  await logoutUser();
                }
              } else {
                await logoutUser();
              }
            }
          } catch (error) {
            logger.error('Session validation failed:', error);
            await logoutUser();
          }
        }
      } catch (error) {
        logger.error('Session initialization error:', error);
        await logoutUser();
      } finally {
        dispatch({ type: 'SET_LOADING', payload: false });
      }
    };

    initializeSession();
  }, [reduxDispatch]);

  const loginUser = async (username: string, password: string) => {
    try {
      logger.info(`Login attempt for user: ${username}`);
      const { user, accessToken, refreshToken } = await authService.login(username, password);
      
      if (!accessToken || !refreshToken) {
        logger.error('Login failed: Missing tokens');
        throw new Error('Login failed: Missing tokens');
      }
      
      await Promise.all([
        storeData('accessToken', accessToken),
        storeData('refreshToken', refreshToken)
      ]);
      
      dispatch({ type: 'LOGIN', payload: user });
      reduxDispatch(login({ user, accessToken }));
      
      try {
        const { profile } = await userService.refreshUserData(user.id);
        reduxDispatch(setProfile(profile));
      } catch (profileError) {
        logger.error('Failed to fetch user profile:', profileError);
        throw profileError;
      }
      
      await userService.addUserSession(user);
      setSessions(prev => [...prev, user]);
      logger.info(`Login successful for user: ${user.id}`);
    } catch (error) {
      logger.error('Login error:', error);
      throw error;
    }
  };

  const logoutUser = async () => {
    try {
      if (state.user) {
        await userService.removeUserSession(state.user.id);
        setSessions(prev => prev.filter(s => s.id !== state.user?.id));
      }
      
      dispatch({ type: 'LOGOUT' });
      reduxDispatch(logout());
      reduxDispatch(clearProfile());
      await authService.logout();
    } catch (error) {
      console.error('Logout error:', error);
      throw error;
    }
  };

  const switchSession = async (userId: string) => {
    try {
      const session = sessions.find(s => s.id === userId);
      if (!session) {
        logger.warn(`Session switch failed: Session not found for user ${userId}`);
        throw new Error('Session not found');
      }
      
      // First try to refresh tokens and user data
      const response = await userService.refreshUserData(userId);
      
      if (!response.accessToken) {
        logger.error(`Session switch failed: No access token received for user ${userId}`);
        throw new Error('Session switch failed: Missing access token');
      }

      // Validate and merge user data, using session as fallback
      if (!response.user || !response.user.id) {
        if (!session.id || !session.username) {
          logger.error(`Session switch failed: Invalid session data for ${userId}`);
          throw new Error('Session switch failed: Invalid session data');
        }
        response.user = session;
      }

      const user = {
        ...session,  // base data from session
        ...response.user, // override with fresh data
        name: response.user?.name || session.name || { first: '', last: '' },
        avatar: response.user?.avatar || session.avatar || ''
      };

      // Final validation of merged user data
      if (!user.username) {
        logger.error(`Session switch failed: Missing required user data for ${userId}`);
        throw new Error('Session switch failed: Missing required user data');
      }

      // Create profile with validated user data
      const userProfile = response.profile || {
        _id: userId,
        userID: userId,
        username: user.username,
        name: user.name,
        avatar: user.avatar
      };
      
      // Update tokens and session state
      await storeData('accessToken', response.accessToken);
      dispatch({ type: 'LOGIN', payload: user });
      reduxDispatch(login({ user, accessToken: response.accessToken }));
      reduxDispatch(setProfile(userProfile));

      logger.info(`Session switched successfully to user ${userId}`);
    } catch (error) {
      logger.error('Session switch error:', error);
      // If this was the last session, log out completely
      if (sessions.length <= 1) {
        await logoutUser();
      }
      throw error;
    }
  };

  const getCurrentUser = () => state.user;

  const contextValue: SessionContextType = {
    state,
    loginUser,
    logoutUser,
    getCurrentUser,
    switchSession,
    sessions
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
