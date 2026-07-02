import { useQuery } from '@tanstack/react-query';
import { authenticatedClient } from '@/utils/api';
import type { ModuleCatalog } from '@mention/shared-types';

/**
 * The custom-feed builder module catalog (`GET /feed/modules`).
 *
 * The catalog is static server config (derived from the module registry), so it
 * is cached aggressively and shared by a single query key. The endpoint is a
 * public read; `authenticatedClient` attaches a token when one exists but works
 * anonymously too.
 */
export function useFeedModules() {
  const query = useQuery<ModuleCatalog>({
    queryKey: ['feedModules'],
    staleTime: 60 * 60 * 1000,
    queryFn: async () => {
      const res = await authenticatedClient.get<ModuleCatalog>('/feed/modules');
      return res.data;
    },
  });

  return {
    catalog: query.data,
    isLoading: query.isLoading,
    error: query.error,
  };
}
