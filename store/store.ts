import { configureStore } from '@reduxjs/toolkit';
import postsReducer from './reducers/postsReducer';
import trendsReducer from './reducers/trendsReducer';
import profileReducer from './reducers/profileReducer';
import followReducer from './reducers/followReducer';
import sessionReducer from './reducers/sessionReducer';

const store = configureStore({
  reducer: {
    posts: postsReducer,
    trends: trendsReducer,
    profile: profileReducer,
    follow: followReducer,
    session: sessionReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export default store;
