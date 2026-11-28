import { useOxyRuntime } from '@oxy.so/services/runtime';
import { logger } from '@oxy.so/core/logger';
import { useLayoutEffect } from 'react';
import { loadSavedFeedsCopy } from '@/lib/savedFeedsCopy';
import { followSessionRuntime } from '@/lib/accountScope';

function prepareAccountData(): void {
  loadSavedFeedsCopy().catch((error: unknown) => {
    logger.warn('Could not read the saved feeds kept on this device', { error });
  });
}

/**
 * Hands the session runtime to `lib/accountScope`, and starts reading what an
 * account keeps on this device as soon as its store is open. Mounted once, as
 * the first child of `OxyProvider`, so it follows the runtime before any account
 * content mounts; it renders nothing.
 */
export function AccountScopeFollower() {
  const runtime = useOxyRuntime();
  useLayoutEffect(() => followSessionRuntime(runtime, prepareAccountData), [runtime]);
  return null;
}
