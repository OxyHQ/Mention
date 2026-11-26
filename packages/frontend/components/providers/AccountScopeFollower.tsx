import { useQueryClient } from '@tanstack/react-query';
import { useOxyRuntime } from '@oxy.so/services/runtime';
import { useLayoutEffect } from 'react';
import { followOxyRuntime } from '@/lib/accountScope';

/**
 * Keeps Mention's account scope (`lib/accountScope.ts`) on the session's
 * account: the query cache is dropped, and a new generation opened, from the
 * runtime's own notification, before anything renders for the next account.
 * Mounted once, as the first child of `OxyProvider`, so it follows the runtime
 * before any account content mounts; it renders nothing.
 */
export function AccountScopeFollower() {
  const runtime = useOxyRuntime();
  const queryClient = useQueryClient();
  useLayoutEffect(() => followOxyRuntime(runtime, queryClient), [runtime, queryClient]);
  return null;
}
