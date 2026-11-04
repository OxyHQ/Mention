import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostType, PostVisibility } from '@mention/shared-types';
import { closePostgres, connectPostgres, getDb } from '../../../db/postgres';
import { federatedActors } from '../../../db/schema';
import { insertPostRecord } from '../../../db/posts/postRepository';
import { keylessTransportRefusal } from '../../../connectors/activitypub/keylessTransport';

const ACCOUNT = 'keylessrule@x.com';
const KEYED = 'https://bird.makeup/users/keylessrule';
const KEYLESS = {
  uri: 'https://mastox.eu/users/keylessrule',
  domain: 'mastox.eu',
  networkAcct: ACCOUNT,
};
const OWNER = 'oxy-keylessrule-owner';
const FIRST_DELIVERY = new Date('2026-03-01T12:00:00.000Z');

beforeAll(async () => {
  await connectPostgres();
  await getDb().insert(federatedActors).values({
    protocol: 'activitypub',
    uri: KEYED,
    username: 'keylessrule',
    domain: 'bird.makeup',
    acct: 'keylessrule@bird.makeup',
    networkAcct: ACCOUNT,
    oxyUserId: OWNER,
  });
});

afterAll(async () => {
  await closePostgres();
});

describe('keylessTransportRefusal', () => {
  it('admits the keyless copy only before the keyed transport first delivered by subscription', async () => {
    const before = new Date(FIRST_DELIVERY.getTime() - 60_000);
    const after = new Date(FIRST_DELIVERY.getTime() + 60_000);
    // No keyed delivery yet: the keyless transport is the only source.
    expect(await keylessTransportRefusal(KEYLESS, after)).toBeNull();

    await insertPostRecord({
      oxyUserId: OWNER,
      authorship: [{ oxyUserId: OWNER, role: 'owner', status: 'accepted' }],
      type: PostType.TEXT,
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      content: { variants: [{ source: 'author', text: 'delivered', tag: 'en' }] },
      federation: {
        activityId: `${KEYED}/statuses/1`,
        actorUri: KEYED,
        importReason: 'inbox_follow',
      },
      createdAt: FIRST_DELIVERY,
      updatedAt: FIRST_DELIVERY,
    });

    expect(await keylessTransportRefusal(KEYLESS, before)).toBeNull();
    expect(await keylessTransportRefusal(KEYLESS, after)).toBe('keyless-after-keyed-subscription');
    // A keyed transport is never refused.
    expect(await keylessTransportRefusal({ uri: KEYED, networkAcct: ACCOUNT }, after)).toBeNull();
  });
});
