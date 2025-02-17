import { useSelector } from 'react-redux';
import { RootState } from '@/store/store';

interface User {
  id: string;
  username: string;
  [key: string]: any;
}

interface SessionState {
  user: User | null;
  accessToken: string | null;
  isAuthenticated: boolean;
}

const useAuth = () => {
  const session = useSelector((state: RootState) => state.session) as SessionState;
  
  return {
    token: session?.accessToken,
    user: session?.user,
    isAuthenticated: !!session?.accessToken && !!session?.user,
  };
};

export default useAuth;