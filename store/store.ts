import { configureStore } from '@reduxjs/toolkit';
import postsReducer from './reducers/postsReducer';
import trendsReducer from './reducers/trendsReducer';

const store = configureStore({
  reducer: {
    posts: postsReducer,
    trends: trendsReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export default store;
