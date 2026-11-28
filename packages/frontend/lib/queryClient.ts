/**
 * Singleton QueryClient for Mention's own server reads.
 *
 * Exported as a module-level instance so non-React code (stores, socket
 * handlers, imperative invalidation) reaches the same cache the app's React
 * Query hooks consume. `components/providers/AppProviders.tsx` provides it and
 * `AccountSwitchReset` clears it when the viewer changes.
 *
 * People are not held here: the SDK keeps them per account in its `User`
 * entity, written through `lib/actorCache.ts`.
 */

import { QueryClient } from '@tanstack/react-query';
import { QUERY_CLIENT_CONFIG } from '@/components/providers/constants';

export const queryClient = new QueryClient(QUERY_CLIENT_CONFIG);
