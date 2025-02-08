import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { RootState } from '../store';
import { getData, storeData } from '@/utils/storage';

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
  lastRefresh?: number;
}

// Initialize with empty state - will be hydrated by SessionProvider
const initialState: SessionState = {
  user: null,
  isAuthenticated: false,
  lastRefresh: undefined
};

const sessionSlice = createSlice({
  name: 'session',
  initialState,
  reducers: {
    login: (state, action: PayloadAction<any>) => {
      state.isAuthenticated = true;
      state.user = action.payload;
      state.lastRefresh = Date.now();
      // Persist session state
      storeData('session', { 
        isAuthenticated: true, 
        user: action.payload,
        lastRefresh: Date.now()
      });
    },
    logout: (state) => {
      state.isAuthenticated = false;
      state.user = null;
      state.lastRefresh = undefined;
      // Clear persisted session
      Promise.all([
        storeData('session', null),
        storeData('accessToken', null),
        storeData('refreshToken', null)
      ]).catch(console.error);
    },
    loadSession: (state, action: PayloadAction<SessionState>) => {
      state.isAuthenticated = action.payload.isAuthenticated;
      state.user = action.payload.user;
      state.lastRefresh = action.payload.lastRefresh;
    },
    updateLastRefresh: (state) => {
      state.lastRefresh = Date.now();
      // Update persisted session
      storeData('session', { 
        isAuthenticated: state.isAuthenticated, 
        user: state.user,
        lastRefresh: Date.now()
      }).catch(console.error);
    }
  },
});

export const { login, logout, loadSession, updateLastRefresh } = sessionSlice.actions;

export const selectSession = (state: RootState) => state.session;

export default sessionSlice.reducer;
