import { useAuth, useSupervision } from '@oxy.so/services/ui/client';

/** Presentation readiness derives from the shared live supervision read. */
export function useSupervisionState() {
  const { user, canUsePrivateApi, isAuthResolved } = useAuth();
  const { value, status, isFetching, updatedAt, refresh } = useSupervision();
  const ready =
    isAuthResolved &&
    (!user ||
      (canUsePrivateApi && ((Boolean(user.kind) && user.kind !== 'personal') || Boolean(value))));
  return {
    /**
     * The last read failed after its retries. While a read that has never been
     * answered is tried again, the state is pending, not failed.
     */
    isError: status === 'error' && !(isFetching && updatedAt === 0),
    refresh,
    ready,
    supervised: ready && (value?.self?.status === 'active' || value?.self?.status === 'orphaned'),
  };
}
