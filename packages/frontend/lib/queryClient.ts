/**
 * Singleton QueryClient — the cache for Mention's own server data.
 *
 * Exported as a module-level instance so non-React code can read and write the
 * same cache the app's queries consume. `AppProviders` mounts it above
 * `OxyProvider`: the Oxy SDK keeps its own data in `@oxy.so/bloom-data` and
 * holds no query client. People are not kept here either: the SDK holds each
 * one once, in its `User` entity (`data/users`).
 *
 * The client's device signals are wired here, once, because nothing else does
 * it: React Query pauses queries while offline and refetches stale ones when
 * the app comes back to the front. On the web its defaults already listen to
 * the browser (`online`/`offline`, `visibilitychange`). On a device it has no
 * signal of its own, so NetInfo and AppState feed it:
 *
 * - Online means "has a network", never NetInfo's reachability probe. That
 *   probe fetches a Google URL; where it is blocked, slow or behind a captive
 *   portal it reports unreachable, and `networkMode: 'online'` would pause
 *   every query (feed modules and who-to-follow stayed on skeletons while
 *   Mention's own API was perfectly reachable). A request that really cannot
 *   get through fails and retries on its own. `null` (not yet known) counts as
 *   connected.
 * - Focused means the app is `active`.
 */

import NetInfo from '@react-native-community/netinfo';
import { focusManager, onlineManager, QueryClient } from '@tanstack/react-query';
import { AppState, Platform } from 'react-native';
import { QUERY_CLIENT_CONFIG } from '@/components/providers/constants';

export const queryClient = new QueryClient(QUERY_CLIENT_CONFIG);

if (Platform.OS !== 'web') {
  onlineManager.setEventListener((setOnline) =>
    NetInfo.addEventListener((state) => setOnline(state.isConnected !== false)),
  );
  focusManager.setEventListener((setFocused) => {
    const subscription = AppState.addEventListener('change', (status) =>
      setFocused(status === 'active'),
    );
    return () => subscription.remove();
  });
}
