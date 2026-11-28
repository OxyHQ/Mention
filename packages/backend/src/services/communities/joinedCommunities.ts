// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { PostUser } from '@mention/shared-types';
import { getFollowingIds, type OxyClient } from '../../utils/privacyHelpers';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import { mergeFederatedFollowIds } from '../feed/viewerFollowGraph';
import { resolveCommunities } from '../accounts/publishAsAccount';

/**
 * The communities the viewer joined — hosted here or remote (Lemmy, PieFed,
 * Mbin) — which is where the composer offers to post. Joining is following, so
 * this is the viewer's follow graph as the feed reads it (Oxy follows plus
 * accepted federated follows), narrowed to Oxy's `community` kind.
 */
export async function listJoinedCommunities(
  viewerId: string,
  client: OxyClient | undefined,
): Promise<PostUser[]> {
  const followed = await getFollowingIds(viewerId, client ?? getServiceOxyClient());
  await mergeFederatedFollowIds(viewerId, followed);
  return [...(await resolveCommunities(followed)).values()];
}
