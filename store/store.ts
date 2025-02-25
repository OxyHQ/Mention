import { combineReducers, configureStore } from "@reduxjs/toolkit";
import trendsReducer from "./reducers/trendsReducer";
import followReducer from './reducers/followReducer';
import analyticsReducer from "./reducers/analyticsReducer";
import profileReducer from "@/modules/oxyhqservices/reducers/profileReducer";

const rootReducer = combineReducers({
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
