// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { loadProviderSdk } from '@peable.to/sdk/checkout';
import { useQuery } from '@tanstack/react-query';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { readLocalCheckoutConfiguration } from '@/lib/payments/checkoutConfiguration';

/** Read-only warmup: opening Plus never creates a subscription or a payer capability. */
export function useCheckoutConfiguration(
  enabled: boolean,
  viewerId: string | undefined,
  sessionId: string | null | undefined,
  scope: string,
) {
  const query = useQuery({
    queryKey: viewerQueryKeys.checkoutConfiguration(viewerId, sessionId, scope),
    queryFn: async ({ signal }) => {
      const configuration = await readLocalCheckoutConfiguration(window.location.href, signal);
      // Script loading is read-only and cached by the SDK; field entry retries a failed warmup.
      void loadProviderSdk().catch(() => {});
      return configuration;
    },
    enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchInterval: (query) =>
      query.state.data ? Math.max(1000, query.state.data.expiresAt - Date.now() - 5000) : 5000,
  });
  return enabled && query.data && query.data.expiresAt > Date.now() ? query.data : undefined;
}
