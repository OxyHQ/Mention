import { getServiceOxyClient } from '../../utils/oxyHelpers';

/**
 * Bridge a federated follow edge into the Oxy follow graph via oxy-api's service
 * route `POST /federation/follow`. Idempotent on both sides: `follow` is a no-op
 * when the edge already exists and `unfollow` when it does not. Throws on
 * transport/HTTP failure so the BullMQ inbox job retries — the whole inbound-follow
 * (and Undo) sequence is retry-safe, so re-running converges. The engine's identity
 * adapter calls this for both directions.
 */
export async function bridgeFollowEdge(
  followerUserId: string,
  targetUserId: string,
  action: 'follow' | 'unfollow',
): Promise<void> {
  await getServiceOxyClient().serviceRequest('POST', '/federation/follow', {
    followerUserId,
    targetUserId,
    action,
  });
}
