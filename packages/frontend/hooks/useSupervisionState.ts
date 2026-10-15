import { useAuth } from '@oxy.so/services/ui/client';
import { useSupervision } from '@oxy.so/services/ui';

/** Presentation readiness derives from the shared live supervision query. */
export function useSupervisionState() {
  const { user, canUsePrivateApi, isAuthResolved } = useAuth();
  const query = useSupervision();
  const ready =
    isAuthResolved &&
    (!user ||
      (canUsePrivateApi &&
        ((Boolean(user.kind) && user.kind !== 'personal') || Boolean(query.data))));
  return {
    ...query,
    ready,
    supervised:
      ready && (query.data?.self?.status === 'active' || query.data?.self?.status === 'orphaned'),
  };
}
