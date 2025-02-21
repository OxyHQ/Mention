import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { RootState } from '../store';
import { getData, storeData } from '@/modules/oxyhqservices/utils/storage';

interface User {
  id: string;
  username: string;
  name?: {
    first?: string;
    last?: string;
  };
  avatar?: string;
  [key: string]: any;
}

interface SessionState {
  user: User | null;
  isAuthenticated: boolean;
  accessToken: string | null;
  lastRefresh?: number;
}

// Initialize with empty state - will be hydrated by SessionProvider
const initialState: SessionState = {
  user: null,
  isAuthenticated: false,
  accessToken: null,
  lastRefresh: undefined
};

const sessionSlice = createSlice({
  name: 'session',
  initialState,
  reducers: {
    login: (state, action: PayloadAction<{ user: User; accessToken: string }>) => {
      state.isAuthenticated = true;
      state.user = action.payload.user;
      state.accessToken = action.payload.accessToken;
      state.lastRefresh = Date.now();
      // Persist session state immediately
      storeData('session', {
        isAuthenticated: true,
        user: action.payload.user,
        accessToken: action.payload.accessToken,
        lastRefresh: Date.now()
      }).catch(error => {
        console.error('Failed to persist session:', error);
      });
    },
    logout: (state) => {
      state.isAuthenticated = false;
      state.user = null;
      state.accessToken = null;
      state.lastRefresh = undefined;
      // Clear all persisted data
      Promise.all([
        storeData('session', null),
        storeData('accessToken', null),
        storeData('refreshToken', null),
        storeData('user', null)
      ]).catch(error => {
        console.error('Failed to clear session data:', error);
      });
    },
    loadSession: (state, action: PayloadAction<SessionState>) => {
      Object.assign(state, action.payload);
    },
    updateLastRefresh: (state) => {
      state.lastRefresh = Date.now();
      // Update persisted session
      storeData('session', { 
        isAuthenticated: state.isAuthenticated, 
        user: state.user,
        accessToken: state.accessToken,
        lastRefresh: Date.now()
      }).catch(console.error);
    }
  },
});

export const { login, logout, loadSession, updateLastRefresh } = sessionSlice.actions;

export const selectSession = (state: RootState) => state.session;

export default sessionSlice.reducer;
