import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '@/store/store';
import { User } from '@/modules/oxyhqservices';
import { useEffect, useState } from 'react';
import { setFollowing } from '@/store/reducers/followReducer';
import { profileService } from '@/modules/oxyhqservices';
import type { OxyProfile } from '@/modules/oxyhqservices/types';

interface SessionState {
  user: User | null;
  accessToken: string | null;
  isAuthenticated: boolean;
}

export const useAuth = () => {
  const session = useSelector((state: RootState) => state.session) as SessionState;
  const dispatch = useDispatch();
  const [isInitializing, setIsInitializing] = useState(true);
  
  useEffect(() => {
    const initializeUser = async () => {
      if (session?.user) {
        try {
          setIsInitializing(true);
          const following = await profileService.getFollowing(session.user.id);
          dispatch(setFollowing(following.map((f: OxyProfile) => f.userID)));
        } catch (error) {
          console.error('Failed to load following list:', error);
        } finally {
          setIsInitializing(false);
        }
      } else {
        setIsInitializing(false);
      }
    };

    initializeUser();
  }, [session?.user?.id]);

  return {
    token: session?.accessToken,
    user: session?.user as User | null,
    isAuthenticated: !!session?.accessToken && !!session?.user,
    isInitializing
  };
};

export default useAuth;