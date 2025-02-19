import { combineReducers, configureStore } from "@reduxjs/toolkit";
import postsReducer from "./reducers/postsReducer";
import sessionReducer from "./reducers/sessionReducer";
import profileReducer from "./reducers/profileReducer";
import trendsReducer from "./reducers/trendsReducer";
import followReducer from './reducers/followReducer';
import analyticsReducer from "./reducers/analyticsReducer";

const rootReducer = combineReducers({
  posts: postsReducer,
  session: sessionReducer,
  profile: profileReducer,
  trends: trendsReducer,
  follow: followReducer,
  analytics: analyticsReducer,
});

export const store = configureStore({
  reducer: rootReducer,
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export default store;
