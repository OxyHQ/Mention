import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A list subscription is re-checked against list visibility at the point of USE,
 * not only at the point of subscription.
 *
 * `POST /entity-follows` now refuses to subscribe a stranger to a private list,
 * but that gate alone is not enough: a subscription outlives the state it was
 * created under. A list can be flipped to private after someone subscribed to
 * it while it was public, and rows written before the gate existed are already
 * in the collection. Since `getSubscribedListMemberIds` feeds member ids
 * straight into the For You candidate query, an unchecked row lets a subscriber
 * infer a private list's membership from whose posts land in their feed — so the
 * members of a list the subscriber may no longer view must be dropped here.
 */

const mocks = vi.hoisted(() => ({
  entityFollowFind: vi.fn(),
  accountListFind: vi.fn(),
}));

vi.mock('../../models/EntityFollow', () => ({ EntityFollow: { find: mocks.entityFollowFind } }));
vi.mock('../../models/AccountList', () => ({ default: { find: mocks.accountListFind } }));
vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ListSubscriptionService } from '../../services/ListSubscriptionService';

const VIEWER_ID = 'viewer-1';
const OWNER_ID = 'stranger-9';

/** Valid ObjectIds — the service filters out ids that are not. */
const PUBLIC_LIST_ID = '65b0c9178fcdefaf81988ffb';
const PRIVATE_LIST_ID = '65b0c9178fcdefaf81988ffc';

/** `EntityFollow.find(...).limit().lean()` — the subscription rows. */
function subscriptionRows(listIds: string[]) {
  mocks.entityFollowFind.mockReturnValue({
    limit: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(listIds.map((entityId) => ({ entityId }))),
  });
}

/** `AccountList.find(...).lean()` — the list documents those rows point at. */
function listDocs(docs: Array<{ memberOxyUserIds: string[]; isPublic?: boolean; ownerOxyUserId: string }>) {
  mocks.accountListFind.mockReturnValue({ lean: vi.fn().mockResolvedValue(docs) });
}

describe('getSubscribedListMemberIds — subscriptions obey list visibility at read time', () => {
  beforeEach(() => {
    mocks.entityFollowFind.mockReset();
    mocks.accountListFind.mockReset();
  });

  it('drops the members of a list that has since gone PRIVATE', async () => {
    subscriptionRows([PRIVATE_LIST_ID]);
    listDocs([{ memberOxyUserIds: ['member-a', 'member-b'], isPublic: false, ownerOxyUserId: OWNER_ID }]);

    const memberIds = await new ListSubscriptionService().getSubscribedListMemberIds(VIEWER_ID);

    // A stale row must contribute NOTHING: any member id returned here reaches
    // the For You candidate query and leaks private membership.
    expect(memberIds).toEqual([]);
  });

  it('still returns the members of a PUBLIC list', async () => {
    subscriptionRows([PUBLIC_LIST_ID]);
    listDocs([{ memberOxyUserIds: ['member-a', 'member-b'], isPublic: true, ownerOxyUserId: OWNER_ID }]);

    const memberIds = await new ListSubscriptionService().getSubscribedListMemberIds(VIEWER_ID);

    expect(memberIds).toEqual(['member-a', 'member-b']);
  });

  it("returns the members of the viewer's OWN private list", async () => {
    subscriptionRows([PRIVATE_LIST_ID]);
    listDocs([{ memberOxyUserIds: ['member-a'], isPublic: false, ownerOxyUserId: VIEWER_ID }]);

    const memberIds = await new ListSubscriptionService().getSubscribedListMemberIds(VIEWER_ID);

    expect(memberIds).toEqual(['member-a']);
  });

  it('keeps the visible list when a private one sits alongside it', async () => {
    subscriptionRows([PUBLIC_LIST_ID, PRIVATE_LIST_ID]);
    listDocs([
      { memberOxyUserIds: ['visible-member'], isPublic: true, ownerOxyUserId: OWNER_ID },
      { memberOxyUserIds: ['hidden-member'], isPublic: false, ownerOxyUserId: OWNER_ID },
    ]);

    const memberIds = await new ListSubscriptionService().getSubscribedListMemberIds(VIEWER_ID);

    expect(memberIds).toEqual(['visible-member']);
  });

  it('treats a list stored without isPublic as private (fails closed)', async () => {
    subscriptionRows([PRIVATE_LIST_ID]);
    listDocs([{ memberOxyUserIds: ['member-a'], ownerOxyUserId: OWNER_ID }]);

    const memberIds = await new ListSubscriptionService().getSubscribedListMemberIds(VIEWER_ID);

    expect(memberIds).toEqual([]);
  });

  it('projects the fields the visibility rule reads, or the rule cannot run', async () => {
    subscriptionRows([PUBLIC_LIST_ID]);
    listDocs([{ memberOxyUserIds: ['member-a'], isPublic: true, ownerOxyUserId: OWNER_ID }]);

    await new ListSubscriptionService().getSubscribedListMemberIds(VIEWER_ID);

    // Guards the silent-failure mode: a projection that omits `isPublic` /
    // `ownerOxyUserId` makes every list read as private and empties the lane,
    // which looks like "no subscriptions" rather than a bug.
    expect(mocks.accountListFind).toHaveBeenCalledWith(expect.anything(), {
      memberOxyUserIds: 1,
      isPublic: 1,
      ownerOxyUserId: 1,
    });
  });
});
