// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { queryOptions } from '@tanstack/react-query';
import type { HydratedPost } from '@mention/shared-types';
import { viewerQueryKeys, type ViewerId } from '@/lib/viewerQueryKeys';
import { feedService } from '@/services/feedService';

/**
 * A profile's pinned post as this viewer is served it. One definition for the
 * profile's posts tab and for the feed row that opens the profile, which starts
 * it from the author id it already holds.
 */
export function pinnedPostQueryOptions(viewerId: ViewerId, profileId: string) {
  return queryOptions<HydratedPost | null>({
    queryKey: viewerQueryKeys.pinnedPost(viewerId, profileId),
    queryFn: () => feedService.getPinnedPost(profileId),
  });
}
