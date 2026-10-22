import type { ReactNode } from 'react';
import { canUseCommunities } from '@mention/shared-types/community';
import { useAuth } from '@oxy.so/services/ui/client';
import NotFoundScreen from '@/components/NotFoundScreen';

/**
 * Communities are in a private preview: only the accounts `canUseCommunities`
 * names see an entry to them. The server answers the same question for what it
 * serves, so hiding the entry points here is not what keeps anyone out.
 */
export function useCommunitiesPreview(): boolean {
  const { user } = useAuth();
  return canUseCommunities(user?.username);
}

/** A communities page: the page that does not exist for everyone outside the preview. */
export function CommunitiesPreviewGate({ children }: { children: ReactNode }) {
  return useCommunitiesPreview() ? <>{children}</> : <NotFoundScreen />;
}
