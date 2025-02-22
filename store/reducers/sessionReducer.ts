import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { RootState } from '../store';

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
      // Removed local storage persistence
    },
    logout: (state) => {
      state.isAuthenticated = false;
      state.user = null;
      state.accessToken = null;
      state.lastRefresh = undefined;
      // Removed local storage clearing
    },
    loadSession: (state, action: PayloadAction<SessionState>) => {
      Object.assign(state, action.payload);
    },
    updateLastRefresh: (state) => {
      state.lastRefresh = Date.now();
      // Removed local storage update
    }
  },
});

export const { login, logout, loadSession, updateLastRefresh } = sessionSlice.actions;

export const selectSession = (state: RootState) => state.session;

export default sessionSlice.reducer;
