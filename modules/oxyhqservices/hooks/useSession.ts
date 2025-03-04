import { useContext } from 'react';
import { SessionContext } from '../components/SessionProvider';

export function useSession() {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error('useSession must be used within a SessionProvider');
  }

  // Wrap loginUser to properly handle validation errors
  const loginUser = async (username: string, password: string) => {
    try {
      await context.loginUser(username, password);
    } catch (error: any) {
      // Preserve the error structure for validation errors
      if (error?.details) {
        throw error;
      }
      // For other errors, ensure we have a message
      throw {
        message: error?.message || 'Login failed',
        details: null
      };
    }
  };

  return {
    ...context,
    loginUser
  };
}