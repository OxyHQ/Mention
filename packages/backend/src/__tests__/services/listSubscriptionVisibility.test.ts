/**
 * List subscriptions, against real rows.
 *
 * Three things are asserted here, and the suite this replaces could only ever
 * see the first of them — it stubbed `EntityFollow.find` and `AccountList.find`
 * and asserted the PROJECTION object the service passed to Mongo.
 *
 * **Visibility at the point of USE.** `POST /entity-follows` refuses to
 * subscribe a stranger to a private list, but that gate alone is not enough: a
 * subscription outlives the state it was created under. A list can be flipped to
 * private after someone subscribed while it was public, and rows written before
 * the gate existed are already in the table. `getSubscribedListMemberIds` feeds
 * member ids straight into the For You candidate query, so an unchecked row
 * lets a subscriber infer a private list's membership from whose posts land in
 * their feed.
 *
 * **The counter guard that is gone.** Both counter methods used to begin with
 * `mongoose.Types.ObjectId.isValid(listId)` and return early. Every list created
 * after the cutover has a uuid v7 id, so that guard would have skipped the
 * maintenance for all of them — `subscriberCount` frozen at 0 forever, with
 * nothing logged and no error anywhere. The counter block below fails the moment
 * such a guard comes back.
 *
 * **The caps warn rather than truncate silently.** Both bounds log; a bound that
 * quietly drops half a viewer's lists is indistinguishable from a viewer who
 * subscribes to fewer lists.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { accountListMembers, accountLists } from '../../db/schema/lists';
import { entityFollows } from '../../db/schema/engagement';
import {
  ListSubscriptionService,
  LIST_ENTITY_TYPE,
  MAX_SUBSCRIBED_LISTS_FOR_FEED,
  MAX_SUBSCRIBED_LIST_AUTHORS_FOR_FEED,
} from '../../services/ListSubscriptionService';
import { logger } from '../../utils/logger';

let db: Database;
const service = new ListSubscriptionService();

const run = randomUUID();
const VIEWER_ID = `viewer-${run}`;
const OWNER_ID = `stranger-${run}`;

const createdListIds: string[] = [];
const subscriberIds = new Set<string>([VIEWER_ID]);

async function makeList(options: {
  isPublic: boolean;
  ownerOxyUserId?: string;
  members?: string[];
}): Promise<string> {
  const [list] = await db
    .insert(accountLists)
    .values({
      ownerOxyUserId: options.ownerOxyUserId ?? OWNER_ID,
      title: `List ${randomUUID()}`,
      isPublic: options.isPublic,
    })
    .returning({ id: accountLists.id });
  createdListIds.push(list.id);

  const members = options.members ?? [];
  if (members.length > 0) {
    await db.insert(accountListMembers).values(
      members.map((oxyUserId, position) => ({ listId: list.id, oxyUserId, position })),
    );
  }
  return list.id;
}

async function subscribe(listId: string, userId: string = VIEWER_ID): Promise<void> {
  subscriberIds.add(userId);
  await db.insert(entityFollows).values({ userId, entityType: LIST_ENTITY_TYPE, entityId: listId });
}

beforeAll(async () => {
  db = await connectPostgres();
});

beforeEach(() => {
  vi.mocked(logger.warn).mockClear();
});

afterEach(async () => {
  if (createdListIds.length > 0) {
    // `account_list_members` cascades with the list; the subscriptions do not
    // (`entity_id` is polymorphic and carries no foreign key), so they go too.
    await db.delete(entityFollows).where(inArray(entityFollows.entityId, createdListIds));
    await db.delete(accountLists).where(inArray(accountLists.id, createdListIds));
    createdListIds.length = 0;
  }
  for (const userId of subscriberIds) {
    await db.delete(entityFollows).where(eq(entityFollows.userId, userId));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('getSubscribedListMemberIds — subscriptions obey list visibility at read time', () => {
  it('drops the members of a list that has since gone PRIVATE', async () => {
    await subscribe(await makeList({ isPublic: false, members: ['member-a', 'member-b'] }));

    // A stale row must contribute NOTHING: any member id returned here reaches
    // the For You candidate query and leaks private membership.
    expect(await service.getSubscribedListMemberIds(VIEWER_ID)).toEqual([]);
  });

  it('still returns the members of a PUBLIC list', async () => {
    await subscribe(await makeList({ isPublic: true, members: ['member-a', 'member-b'] }));

    expect(await service.getSubscribedListMemberIds(VIEWER_ID)).toEqual(['member-a', 'member-b']);
  });

  it("returns the members of the viewer's OWN private list", async () => {
    await subscribe(
      await makeList({ isPublic: false, ownerOxyUserId: VIEWER_ID, members: ['member-a'] }),
    );

    expect(await service.getSubscribedListMemberIds(VIEWER_ID)).toEqual(['member-a']);
  });

  it('keeps the visible list when a private one sits alongside it', async () => {
    await subscribe(await makeList({ isPublic: true, members: ['visible-member'] }));
    await subscribe(await makeList({ isPublic: false, members: ['hidden-member'] }));

    expect(await service.getSubscribedListMemberIds(VIEWER_ID)).toEqual(['visible-member']);
  });

  it('deduplicates a member who appears on two subscribed lists', async () => {
    await subscribe(await makeList({ isPublic: true, members: ['shared', 'only-first'] }));
    await subscribe(await makeList({ isPublic: true, members: ['shared', 'only-second'] }));

    expect((await service.getSubscribedListMemberIds(VIEWER_ID)).sort()).toEqual([
      'only-first',
      'only-second',
      'shared',
    ]);
  });

  it('returns nothing for a viewer who subscribes to nothing', async () => {
    // The vacuity floor: the cases above must not pass because everything passes.
    await makeList({ isPublic: true, members: ['member-a'] });

    expect(await service.getSubscribedListMemberIds(VIEWER_ID)).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('tolerates a subscription whose list has been deleted', async () => {
    const listId = await makeList({ isPublic: true, members: ['member-a'] });
    await subscribe(listId);
    await db.delete(accountLists).where(eq(accountLists.id, listId));

    // `entity_id` is polymorphic and carries no foreign key, so the row survives
    // the list. It must resolve to no members rather than throwing.
    expect(await service.getSubscribedListMemberIds(VIEWER_ID)).toEqual([]);
  });
});

describe('subscriberCount maintenance — no id-shape guard stands in front of it', () => {
  it('increments for a list whose id is a uuid v7', async () => {
    /**
     * THE regression test for the deleted `ObjectId.isValid` guard. Under it this
     * call returns before touching anything, and the failure is invisible: the
     * method still resolves, the follow still succeeds, and the count simply
     * never moves.
     */
    const listId = await makeList({ isPublic: true });
    expect(listId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/i);

    await service.incrementSubscriberCount(listId);
    await service.incrementSubscriberCount(listId);

    expect(await readSubscriberCount(listId)).toBe(2);
  });

  it('decrements for a uuid v7 list id, back down to zero', async () => {
    const listId = await makeList({ isPublic: true });
    await service.incrementSubscriberCount(listId);

    await service.decrementSubscriberCount(listId);

    expect(await readSubscriberCount(listId)).toBe(0);
  });

  it('never drives the count below zero, and leaves the row untouched at zero', async () => {
    /**
     * `account_lists_subscriber_count_check` refuses a negative value, so an
     * unguarded decrement on a zeroed counter would be a constraint violation
     * rather than a no-op. Mongo filtered on `subscriberCount > 0`; so does this,
     * which also means `updated_at` — a sort key for `GET /lists` — does not move.
     */
    const listId = await makeList({ isPublic: true });
    const before = await readUpdatedAt(listId);

    await service.decrementSubscriberCount(listId);

    expect(await readSubscriberCount(listId)).toBe(0);
    expect((await readUpdatedAt(listId)).getTime()).toBe(before.getTime());
  });

  it('updates no row at all for an id that names no list', async () => {
    const listId = await makeList({ isPublic: true });

    await service.incrementSubscriberCount(`no-such-list-${run}`);

    expect(await readSubscriberCount(listId)).toBe(0);
  });
});

describe('the feed caps warn rather than truncating silently', () => {
  it('caps the number of subscribed lists and says so', async () => {
    const overCap = MAX_SUBSCRIBED_LISTS_FOR_FEED + 1;
    // One member per list, so the author cap cannot fire and confuse the check.
    const listIds: string[] = [];
    for (let index = 0; index < overCap; index += 1) {
      listIds.push(
        await makeList({ isPublic: true, members: [`capped-member-${String(index).padStart(4, '0')}`] }),
      );
    }
    await db.insert(entityFollows).values(
      listIds.map((entityId) => ({ userId: VIEWER_ID, entityType: LIST_ENTITY_TYPE, entityId })),
    );

    const memberIds = await service.getSubscribedListMemberIds(VIEWER_ID);

    // One list was dropped, so exactly one member is missing — and the drop was
    // ANNOUNCED.
    expect(memberIds).toHaveLength(MAX_SUBSCRIBED_LISTS_FOR_FEED);
    expect(logger.warn).toHaveBeenCalledWith(
      '[ListSubscriptionService] Subscribed-list count exceeds cap; truncating',
      expect.objectContaining({ userId: VIEWER_ID, cap: MAX_SUBSCRIBED_LISTS_FOR_FEED }),
    );
  });

  it('caps the number of contributed authors and says so', async () => {
    const overCap = MAX_SUBSCRIBED_LIST_AUTHORS_FOR_FEED + 1;
    const members = Array.from(
      { length: overCap },
      (_, index) => `bulk-member-${String(index).padStart(5, '0')}`,
    );
    await subscribe(await makeList({ isPublic: true, members }));

    const memberIds = await service.getSubscribedListMemberIds(VIEWER_ID);

    expect(memberIds).toHaveLength(MAX_SUBSCRIBED_LIST_AUTHORS_FOR_FEED);
    expect(logger.warn).toHaveBeenCalledWith(
      '[ListSubscriptionService] Subscribed-list author count exceeds cap; truncating',
      expect.objectContaining({ userId: VIEWER_ID, cap: MAX_SUBSCRIBED_LIST_AUTHORS_FOR_FEED }),
    );
  });

  it('does not warn when a viewer sits exactly ON the author cap', async () => {
    const members = Array.from(
      { length: MAX_SUBSCRIBED_LIST_AUTHORS_FOR_FEED },
      (_, index) => `exact-member-${String(index).padStart(5, '0')}`,
    );
    await subscribe(await makeList({ isPublic: true, members }));

    expect(await service.getSubscribedListMemberIds(VIEWER_ID)).toHaveLength(
      MAX_SUBSCRIBED_LIST_AUTHORS_FOR_FEED,
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

async function readSubscriberCount(listId: string): Promise<number> {
  const [row] = await db
    .select({ subscriberCount: accountLists.subscriberCount })
    .from(accountLists)
    .where(eq(accountLists.id, listId));
  return row.subscriberCount;
}

async function readUpdatedAt(listId: string): Promise<Date> {
  const [row] = await db
    .select({ updatedAt: accountLists.updatedAt })
    .from(accountLists)
    .where(eq(accountLists.id, listId));
  return row.updatedAt;
}
