import { useContext } from 'react';
import { SessionContext } from '../components/SessionProvider';
import type { User } from '../services/auth.service';

export function useAuth() {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error('useAuth must be used within a SessionProvider');
  }
  
  return {
    token: context.state.user?.id ? 'secured' : null,
    user: context.state.user,
    isAuthenticated: !!context.state.user,
  };
}