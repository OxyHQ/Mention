import { Redirect, usePathname } from 'expo-router';
import { useWelcomeStatus } from '@/hooks/useWelcome';

/**
 * Sends an account that has not been through `/welcome` there, once, and back
 * to where it was going afterwards (`next`). It renders nothing otherwise, and
 * it never touches the home screen itself: the flow is its own route.
 */
export function WelcomeRedirectGate() {
  const { needsWelcome } = useWelcomeStatus();
  const pathname = usePathname();
  if (!needsWelcome || pathname === '/welcome') return null;
  return (
    <Redirect href={{ pathname: '/welcome', params: pathname === '/' ? {} : { next: pathname } }} />
  );
}
