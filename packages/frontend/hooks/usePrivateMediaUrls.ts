// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';

/** Own compose/draft media uses the same canonical asset access as published posts. */
export function usePrivateMediaUrls(
  files: readonly { fileId: string; variant?: string }[],
): (fileId: string) => string {
  const { oxyServices, user, canUsePrivateApi } = useAuth();
  const requests = useMemo(
    () =>
      [
        ...new Map(
          files
            .filter(({ fileId }) => fileId && !/^https?:\/\//i.test(fileId))
            .map((file) => [file.fileId, file]),
        ).values(),
      ].sort((left, right) => left.fileId.localeCompare(right.fileId)),
    [files],
  );
  const query = useQuery({
    queryKey: viewerQueryKeys.composeMedia(user?.id, canUsePrivateApi, requests),
    enabled: canUsePrivateApi && Boolean(user?.id) && requests.length > 0,
    queryFn: async () => {
      const urls: Record<string, string> = {};
      for (let index = 0; index < requests.length; index += 100)
        Object.assign(
          urls,
          await oxyServices.assets.urls(requests.slice(index, index + 100), {
            context: 'mention-compose',
          }),
        );
      return urls;
    },
    staleTime: 0,
    gcTime: 0,
  });
  return useCallback(
    (fileId: string) => {
      if (/^https?:\/\//i.test(fileId)) return fileId;
      return canUsePrivateApi && query.isSuccess ? (query.data[fileId] ?? '') : '';
    },
    [canUsePrivateApi, query.isSuccess, query.data],
  );
}
