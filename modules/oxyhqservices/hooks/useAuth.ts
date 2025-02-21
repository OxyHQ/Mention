import { useSelector } from 'react-redux';
import { RootState } from '@/store/store';
import type { User } from '../services/auth.service';

interface SessionState {
  user: User | null;
  accessToken: string | null;
  isAuthenticated: boolean;
}

export function useAuth() {
  const session = useSelector((state: RootState) => state.session) as SessionState;
  
  return {
    token: session?.accessToken,
    user: session?.user,
    isAuthenticated: !!session?.accessToken && !!session?.user,
  };
}