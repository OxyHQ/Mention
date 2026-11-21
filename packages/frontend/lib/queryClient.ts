/**
 * Singleton QueryClient — the cache for Mention's own server data.
 *
 * Exported as a module-level instance so non-React code can read and write the
 * same cache the app's queries consume. `AppProviders` mounts it above
 * `OxyProvider`: the Oxy SDK keeps its own data in `@oxy.so/bloom-data` and
 * holds no query client. People are not kept here either: the SDK holds each
 * one once, in its `User` entity (`data/users`).
 *
 * React Query pauses queries while offline and refetches stale ones when the
 * app comes back to the front, so it needs the device's signals. It reads them
 * from bloom-data's `environment`, the one owner of both: the Oxy SDK feeds it
 * on a device (NetInfo's `isConnected`, never the reachability probe, and
 * AppState) and the browser feeds it on the web. One listener, one rule.
 */

import { environment } from '@oxy.so/bloom-data';
import { focusManager, onlineManager, QueryClient } from '@tanstack/react-query';
import { QUERY_CLIENT_CONFIG } from '@/components/providers/constants';

export const queryClient = new QueryClient(QUERY_CLIENT_CONFIG);

onlineManager.setEventListener((setOnline) => {
  setOnline(environment.online);
  return environment.subscribe((event) => {
    if (event === 'online' || event === 'offline') setOnline(event === 'online');
  });
});
focusManager.setEventListener((setFocused) => {
  setFocused(environment.focused);
  return environment.subscribe((event) => {
    if (event === 'focus' || event === 'blur') setFocused(event === 'focus');
  });
});
