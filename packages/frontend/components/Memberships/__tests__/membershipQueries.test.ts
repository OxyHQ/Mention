import { canReadMembership, membershipKeys, membershipQueryPolicy } from '../membershipQueries';
import type { CommunityMembership, MembershipLandingResponse } from '@mention/shared-types';
const member: CommunityMembership = {
  id: 'm',
  communityId: 'c',
  tierId: 't',
  state: 'active',
  publicBadge: false,
  startedAt: '',
  accessEndsAt: null,
  cancelledAt: null,
};
const landing: MembershipLandingResponse = {
  community: {
    id: 'c',
    ownerOxyUserId: 'owner',
    name: 'Community',
    slug: 'community',
    description: '',
    visibility: 'public',
    status: 'active',
    createdAt: '',
    updatedAt: '',
  },
  membership: member,
  viewerBenefits: ['content_read', 'discussion_write', 'polls_vote', 'media_download'],
  canManage: false,
  tiers: [],
  paidSubscriptionsAvailable: false,
};
it('separates every member response by viewer, community and thread', () => {
  expect(membershipKeys.content('a', 'c')).not.toEqual(membershipKeys.content('b', 'c'));
  expect(membershipKeys.content('a', 'c')).not.toEqual(membershipKeys.content('a', 'other'));
  expect(membershipKeys.content('a', 'c')).not.toEqual(membershipKeys.content('a', 'c', 'thread'));
  expect(membershipKeys.landing(undefined, 'c')).not.toEqual(membershipKeys.landing('a', 'c'));
  expect(membershipKeys.content('a', 'c').slice(0, 2)).toEqual(['viewer', 'a']);
});
it('never persists or retains an inactive protected response', () => {
  expect(membershipQueryPolicy).toMatchObject({
    meta: { persist: false },
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });
});
it('requires unexpired member access and honors revocation even with a future expiry', () => {
  expect(canReadMembership(landing, 1000)).toBe(true);
  for (const state of ['revoked', 'expired', 'refunded'] as const) {
    expect(
      canReadMembership(
        {
          ...landing,
          membership: { ...member, state, accessEndsAt: new Date(2000).toISOString() },
        },
        1000,
      ),
    ).toBe(false);
  }
  for (const state of ['grace_period', 'cancelled'] as const) {
    expect(canReadMembership({ ...landing, membership: { ...member, state } }, 1000)).toBe(false);
    expect(
      canReadMembership(
        {
          ...landing,
          membership: { ...member, state, accessEndsAt: new Date(2000).toISOString() },
        },
        1000,
      ),
    ).toBe(true);
    expect(
      canReadMembership(
        {
          ...landing,
          membership: { ...member, state, accessEndsAt: new Date(1000).toISOString() },
        },
        1000,
      ),
    ).toBe(false);
  }
});
it('allows draft management but never closed or suspended content', () => {
  expect(
    canReadMembership({
      ...landing,
      community: { ...landing.community, status: 'draft' },
      canManage: true,
    }),
  ).toBe(true);
  for (const status of ['closed', 'suspended'] as const)
    expect(
      canReadMembership({
        ...landing,
        community: { ...landing.community, status },
        canManage: true,
      }),
    ).toBe(false);
  expect(canReadMembership({ ...landing, membership: null })).toBe(false);
});
it('keeps metadata, moderation, directory and private pages inside the same viewer eviction boundary', () => {
  const keys = [
    membershipKeys.mine('a'),
    membershipKeys.community('a', 'c'),
    membershipKeys.landing('a', 'c', true),
    membershipKeys.content('a', 'c'),
    membershipKeys.thread('a', 'c', 'thread'),
    membershipKeys.teaser('a', 'c', 'thread'),
    membershipKeys.insights('a', 'c'),
    membershipKeys.reports('a', 'c'),
    membershipKeys.directory('a', 'c'),
  ];
  for (const key of keys) expect(key.slice(0, 2)).toEqual(['viewer', 'a']);
  expect(new Set(keys.map((key) => JSON.stringify(key))).size).toBe(keys.length);
  expect(membershipKeys.landing('a', 'c', false)).not.toEqual(
    membershipKeys.landing('a', 'c', true),
  );
  expect(canReadMembership({ ...landing, viewerBenefits: [] })).toBe(false);
  expect(
    canReadMembership({ ...landing, community: { ...landing.community, status: 'draft' } }),
  ).toBe(false);
});
