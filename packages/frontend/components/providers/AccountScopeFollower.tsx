import { useQueryClient } from '@tanstack/react-query';
import { logger } from '@oxy.so/core/logger';
import { useOxyRuntime } from '@oxy.so/services/runtime';
import { useLayoutEffect } from 'react';
import { forgetAccountData } from '@/data/accounts';
import { followOxyRuntime } from '@/lib/accountScope';

/** A sign-out deletes the account's posts and feeds from this device. */
function forgetSignedOut(accountId: string): void {
  forgetAccountData(accountId).catch((error: unknown) => {
    logger.warn("Could not delete a signed-out account's data", { error });
  });
}

/**
 * Keeps Mention's account scope (`lib/accountScope.ts`) on the session's
 * account: the query cache is dropped, and a new generation opened, from the
 * runtime's own notification, before anything renders for the next account;
 * a sign-out also deletes the account's stored posts and feeds. Mounted once,
 * as the first child of `OxyProvider`, so it follows the runtime before any
 * account content mounts; it renders nothing.
 */
export function AccountScopeFollower() {
  const runtime = useOxyRuntime();
  const queryClient = useQueryClient();
  useLayoutEffect(
    () => followOxyRuntime(runtime, queryClient, forgetSignedOut),
    [runtime, queryClient],
  );
  return null;
}
