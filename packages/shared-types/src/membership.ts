/** Memberships are an explicit Mention domain, independent of follows/Oxy account seats. */
export const MEMBERSHIP_COMMUNITY_STATES = [
  'draft',
  'active',
  'paused',
  'closed',
  'suspended',
] as const;
export const MEMBERSHIP_TIER_STATES = ['draft', 'active', 'retired'] as const;
export const MEMBERSHIP_STATES = [
  'active',
  'grace_period',
  'cancelled',
  'expired',
  'refunded',
  'revoked',
] as const;
export const MEMBERSHIP_BENEFITS = [
  'content_read',
  'discussion_write',
  'polls_vote',
  'media_download',
] as const;
export type MembershipBenefit = (typeof MEMBERSHIP_BENEFITS)[number];
export type MembershipState = (typeof MEMBERSHIP_STATES)[number];
export type MembershipCommunityState = (typeof MEMBERSHIP_COMMUNITY_STATES)[number];
export const MEMBERSHIP_CONTENT_KINDS = ['post', 'article', 'discussion', 'poll'] as const;

export interface MembershipCommunity {
  id: string;
  ownerOxyUserId: string;
  slug: string;
  name: string;
  description: string;
  visibility: 'public' | 'unlisted';
  status: MembershipCommunityState;
  createdAt: string;
  updatedAt: string;
}
export interface MembershipTier {
  id: string;
  communityId: string;
  name: string;
  description: string;
  kind: 'free' | 'paid';
  status: (typeof MEMBERSHIP_TIER_STATES)[number];
  benefits: MembershipBenefit[];
}
export interface CommunityMembership {
  id: string;
  communityId: string;
  tierId: string;
  state: MembershipState;
  publicBadge: boolean;
  startedAt: string;
  accessEndsAt: string | null;
  cancelledAt: string | null;
}
/** Teasers are authored separately. No body, media or poll field exists on this DTO. */
export interface MembershipContentTeaser {
  id: string;
  communityId: string;
  authorOxyUserId: string;
  kind: (typeof MEMBERSHIP_CONTENT_KINDS)[number];
  teaser: string | null;
  requiredTierIds: string[];
  createdAt: string;
}
export interface MembershipContent extends MembershipContentTeaser {
  title: string | null;
  body: string;
  parentContentId: string | null;
  media: { id: string; mime: string; size: number }[];
  poll: {
    endsAt: string;
    options: { id: string; text: string; votes: number }[];
    selectedOptionId: string | null;
  } | null;
}
export interface CreateMembershipCommunityRequest {
  ownerOxyUserId: string;
  name: string;
  slug: string;
  description?: string;
  visibility?: 'public' | 'unlisted';
}
export interface CreateMembershipTierRequest {
  name: string;
  description?: string;
  kind: 'free' | 'paid';
  benefits: MembershipBenefit[];
}
export interface CreateMembershipContentRequest {
  kind: (typeof MEMBERSHIP_CONTENT_KINDS)[number];
  title?: string;
  body: string;
  teaser?: string;
  requiredTierIds?: string[];
  parentContentId?: string;
  mediaIds?: string[];
  poll?: { options: string[]; endsAt: string };
}
export interface MembershipLandingResponse {
  community: MembershipCommunity;
  tiers: MembershipTier[];
  membership: CommunityMembership | null;
  canManage: boolean;
  paidSubscriptionsAvailable: false;
}
