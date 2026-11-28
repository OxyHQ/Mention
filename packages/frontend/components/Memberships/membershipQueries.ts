export { membershipKeys } from '@/lib/viewerQueryKeys';
import type { MembershipLandingResponse, CommunityMembership } from '@mention/shared-types';

/** Ephemeral only: protected bodies and signed links never enter persisted query storage. */
export const membershipQueryPolicy = {
  staleTime: 0,
  gcTime: 0,
  retry: false,
  refetchOnWindowFocus: true,
  meta: { persist: false },
} as const;
export function canReadMembership(landing: MembershipLandingResponse, now = Date.now()): boolean {
  if (['closed', 'suspended'].includes(landing.community.status)) return false;
  if (landing.canManage) return true;
  if (!landing.viewerBenefits.includes('content_read')) return false;
  if (!['active', 'paused'].includes(landing.community.status)) return false;
  return hasCurrentMembership(landing.membership, now);
}
export function hasCurrentMembership(
  member: CommunityMembership | null,
  now = Date.now(),
): boolean {
  if (!member) return false;
  if (!['active', 'grace_period', 'cancelled'].includes(member.state)) return false;
  if (!member.accessEndsAt) return member.state === 'active';
  return new Date(member.accessEndsAt).getTime() > now;
}
