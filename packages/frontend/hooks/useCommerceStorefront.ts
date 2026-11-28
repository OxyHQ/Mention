// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { useScreenVisible } from '@oxy.so/bloom/screen';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { commerceService } from '@/services/commerceService';

export function useCommerceStorefront(accountId?: string) {
  const { user } = useAuth();
  const visible = useScreenVisible();
  return useQuery({
    queryKey: viewerQueryKeys.commerceStorefront(user?.id, accountId),
    queryFn: () => commerceService.storefront(accountId ?? ''),
    enabled: Boolean(accountId) && visible,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}
