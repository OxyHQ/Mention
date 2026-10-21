import type { PostUser } from '@mention/shared-types';
import { getFollowingIds, type OxyClient } from '../../utils/privacyHelpers';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import { mergeFederatedFollowIds } from '../viewerFollowGraph';
import { resolveCommunities } from '../publishAsAccount';

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
