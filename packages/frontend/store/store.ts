import { combineReducers, configureStore } from "@reduxjs/toolkit";
import analyticsReducer from "./reducers/analyticsReducer";
import trendsReducer from "./reducers/trendsReducer";
import profileReducer from "./reducers/profileReducer"; // Handles profiles linked to Oxy users
import postsReducer from "./reducers/postsReducer";
import uiReducer from "./reducers/uiReducer";
import { setupOxyStore } from '@oxyhq/services';

const rootReducer = combineReducers({
  ...setupOxyStore(),
  trends: trendsReducer,
  analytics: analyticsReducer,
  profile: profileReducer, // Renamed from 'user' to 'profile'
  posts: postsReducer,
  ui: uiReducer,
});

export const store = configureStore({
  reducer: rootReducer,
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export default store;