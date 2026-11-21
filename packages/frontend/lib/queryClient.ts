/**
 * Singleton QueryClient — the single in-memory cache for the whole app.
 *
 * Exported as a module-level instance so non-React code can read and write the
 * same cache that the SDK's React Query hooks and components consume. People
 * are not kept here: the Oxy SDK holds each one once, in its `User` entity
 * (`data/users`).
 *
 * `app/_layout.tsx` passes this instance to `AppProviders` → `OxyProvider`,
 * so the SDK hooks and Mention's `setQueryData` share ONE client.
 */

import { QueryClient } from '@tanstack/react-query';
import { QUERY_CLIENT_CONFIG } from '@/components/providers/constants';

export const queryClient = new QueryClient(QUERY_CLIENT_CONFIG);
