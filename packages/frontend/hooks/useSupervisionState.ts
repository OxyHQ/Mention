// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { useAuth, useSupervision } from '@oxy.so/services/ui/client';

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
