import { useAuth, useSupervision } from '@oxy.so/services/ui/client';

/** Presentation readiness derives from the shared live supervision read. */
export function useSupervisionState() {
  const { user, canUsePrivateApi, isAuthResolved } = useAuth();
  const supervision = useSupervision();
  const ready =
    isAuthResolved &&
    (!user ||
      (canUsePrivateApi &&
        ((Boolean(user.kind) && user.kind !== 'personal') || Boolean(supervision.value))));
  return {
    ...supervision,
    /** The last read failed after its retries (Services 14's `isError`). */
    isError: supervision.status === 'error',
    ready,
    supervised:
      ready &&
      (supervision.value?.self?.status === 'active' ||
        supervision.value?.self?.status === 'orphaned'),
  };
}
