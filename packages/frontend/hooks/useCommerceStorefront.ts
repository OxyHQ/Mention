import { useScreenVisible } from '@oxy.so/bloom/screen';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { commerceService } from '@/services/commerceService';

export function useCommerceStorefront(accountId?: string) {
  const { user } = useAuth();
  const visible = useScreenVisible();
  return useQuery({
    queryKey: ['commerce-storefront', user?.id ?? null, accountId],
    queryFn: () => commerceService.storefront(accountId ?? ''),
    enabled: Boolean(accountId) && visible,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}
