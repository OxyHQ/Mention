/**
 * RealtimeNotificationsBridge Component
 *
 * Keeps the notifications socket connected app-wide (mounted under OxyProvider so
 * `useAuth` resolves), independent of whether the notifications screen is open.
 * This is what lets the bell badge update live from anywhere in the app. Mount it
 * exactly ONCE — the socket is a module singleton, so a second mount would double
 * every listener.
 */

import { useRealtimeNotifications } from '@/hooks/useRealtimeNotifications';

export function RealtimeNotificationsBridge(): null {
  useRealtimeNotifications();
  return null;
}
