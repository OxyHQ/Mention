import type { ProfileConnectionsPage } from '@mention/shared-types/profile';
import { authenticatedClient } from '../utils/api';

/**
 * One page of a profile's followers or following from Mention
 * (`GET /profile/connections/:userId/:kind`): the account's Oxy follow graph,
 * then the edges Mention mirrored from a federated account's origin whose other
 * end is an account known here. Public; a signed-in viewer's blocks and mutes
 * are removed server-side.
 */
export async function fetchProfileConnections(
  userId: string,
  kind: 'followers' | 'following',
  cursor?: string,
): Promise<ProfileConnectionsPage> {
  const response = await authenticatedClient.get<ProfileConnectionsPage>(
    `/profile/connections/${encodeURIComponent(userId)}/${kind}`,
    cursor ? { params: { cursor } } : undefined,
  );
  return response.data;
}
