import type { Persister } from '@oxy.so/bloom-data';

/**
 * Web keeps no durable copy of posts and feeds, as before: expo-sqlite on web
 * needs SharedArrayBuffer (COOP and COEP headers), which would break popup
 * sign-in and embeds. The native build has its own file (`persister.native.ts`).
 */
export function accountPersister(_account: string): Persister | undefined {
  return undefined;
}
