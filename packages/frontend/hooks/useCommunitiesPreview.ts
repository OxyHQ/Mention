import { canUseCommunities } from '@mention/shared-types/community';
import { useAuth } from '@oxy.so/services/ui/client';

/**
 * Communities are in a private preview: only the accounts `canUseCommunities`
 * names see an entry to them. The server answers the same question for what it
 * serves, so hiding the entry points here is not what keeps anyone out.
 */
export function useCommunitiesPreview(): boolean {
  const { user } = useAuth();
  return canUseCommunities(user?.username);
}
