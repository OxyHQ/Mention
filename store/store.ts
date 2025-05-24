import { combineReducers, configureStore } from "@reduxjs/toolkit";
import analyticsReducer from "./reducers/analyticsReducer";
import trendsReducer from "./reducers/trendsReducer";

const rootReducer = combineReducers({
  trends: trendsReducer,
  analytics: analyticsReducer,
});

export const store = configureStore({
  reducer: rootReducer,
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export default store;