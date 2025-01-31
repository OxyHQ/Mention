import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { RootState } from '../store';
import { getData, storeData } from '@/utils/storage';

interface SessionState {
  isAuthenticated: boolean;
  user: any | null;
}

const initialState: SessionState = {
  isAuthenticated: false,
  user: null,
};

const sessionSlice = createSlice({
  name: 'session',
  initialState,
  reducers: {
    login: (state, action: PayloadAction<any>) => {
      state.isAuthenticated = true;
      state.user = action.payload;
      storeData('session', state);
    },
    logout: (state) => {
      state.isAuthenticated = false;
      state.user = null;
      storeData('session', state);
    },
    loadSession: (state, action: PayloadAction<SessionState>) => {
      state.isAuthenticated = action.payload.isAuthenticated;
      state.user = action.payload.user;
    },
  },
});

export const { login, logout, loadSession } = sessionSlice.actions;

export const selectSession = (state: RootState) => state.session;

export default sessionSlice.reducer;
