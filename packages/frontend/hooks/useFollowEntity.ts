// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { useCallback, useEffect } from 'react';
import { useEntityFollowStore } from '@/stores/entityFollowStore';
import type { EntityFollowType } from '@/services/entityFollowService';

export function useFollowEntity(entityType: EntityFollowType, entityId: string) {
  const key = `${entityType}:${entityId}`;
  const isFollowing = useEntityFollowStore((s) => s.following[key] ?? false);
  const isLoading = useEntityFollowStore((s) => s.loading[key] ?? false);

  useEffect(() => {
    if (entityType && entityId) {
      useEntityFollowStore.getState().fetchStatus(entityType, entityId);
    }
  }, [entityType, entityId]);

  const toggle = useCallback(() => {
    return useEntityFollowStore.getState().toggleFollow(entityType, entityId);
  }, [entityType, entityId]);

  return { isFollowing, isLoading, toggle };
}
