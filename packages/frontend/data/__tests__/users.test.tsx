import TestRenderer, { act } from 'react-test-renderer';
import { setActiveStore, Store, withStore } from '@oxy.so/bloom-data';

// The real `User` and `storeUsers`, without the SDK's UI barrel.
jest.mock('@oxy.so/services/ui/client', () => jest.requireActual('@/test-support/oxyUsers'));

import { storeUsers, User } from '@oxy.so/services/ui/client';
import { getPost, storePosts } from '../posts';
import { currentHeldUser, type HeldUser, useHeldUsers, withHeldUser } from '../users';

/**
 * Every person Mention shows is held once per account, in the Oxy SDK's `User`.
 * A post keeps only the ids of the people it embeds (`data/posts` refs); a row's
 * own copy of a person (a byline, a reposter) is laid over by the held one
 * (`data/users`). These pin what that has to guarantee: a profile edit reaches
 * every post at once, a feed answer hydrated before it cannot undo it, the
 * "Unknown user" placeholder never replaces a resolved person, and one account's
 * people never reach another's.
 */

const HYDRATED_AT = '2026-08-01T00:00:00.000Z';
const EDITED_AT = '2026-08-02T00:00:00.000Z';

function person(id: string, avatar: string, updatedAt: string | undefined = HYDRATED_AT) {
  return {
    id,
    username: id,
    name: { displayName: id.toUpperCase() },
    avatar,
    ...(updatedAt ? { updatedAt } : {}),
  };
}

/** A post embedding a person at every field a ref names. */
function post(id: string, people: { author: string; avatar?: string; updatedAt?: string }) {
  const at = people.updatedAt ?? HYDRATED_AT;
  return {
    id,
    content: {},
    attachments: {},
    metadata: { createdAt: HYDRATED_AT },
    user: person(people.author, people.avatar ?? 'before', at),
    community: person('community', 'community-avatar', at),
    replyContext: { parentAuthor: person('parent', 'parent-avatar', at) },
    boost: { originalPost: null, actor: person('booster', 'booster-avatar', at) },
  };
}

/** An accepted profile write, as the SDK stores Oxy's answer. */
function edit(id: string, avatar: string): void {
  storeUsers({ id, avatar, updatedAt: EDITED_AT });
}

beforeEach(() => {
  setActiveStore(new Store());
});

describe('a post holds the people it embeds in User', () => {
  it('stores each embedded person once and reads them back through the post', () => {
    storePosts([post('p1', { author: 'ada' })] as never);

    for (const id of ['ada', 'community', 'parent', 'booster']) {
      expect(User.get(id)).toMatchObject({ id });
    }
    const stored = getPost('p1');
    expect(stored?.user).toMatchObject({ id: 'ada', avatar: 'before' });
    expect(stored?.community).toMatchObject({ id: 'community' });
    expect(stored?.replyContext?.parentAuthor).toMatchObject({ id: 'parent' });
    expect(stored?.boost?.actor).toMatchObject({ id: 'booster' });
  });

  it('shows a profile edit on every post by that person', () => {
    storePosts([post('p1', { author: 'ada' }), post('p2', { author: 'ada' })] as never);

    edit('ada', 'after');

    expect(getPost('p1')?.user.avatar).toBe('after');
    expect(getPost('p2')?.user.avatar).toBe('after');
  });

  it('keeps the edit when a feed answer hydrated before it arrives', () => {
    storePosts([post('p1', { author: 'ada' })] as never);
    edit('ada', 'after');

    storePosts([post('p1', { author: 'ada' }), post('p3', { author: 'ada' })] as never);

    expect(getPost('p1')?.user.avatar).toBe('after');
    expect(getPost('p3')?.user.avatar).toBe('after');
  });

  it('takes a copy Oxy changed after the edit', () => {
    storePosts([post('p1', { author: 'ada' })] as never);
    edit('ada', 'after');

    storePosts([
      post('p1', { author: 'ada', avatar: 'later', updatedAt: '2026-08-03T00:00:00.000Z' }),
    ] as never);

    expect(getPost('p1')?.user.avatar).toBe('later');
  });

  it('never lets the "Unknown user" placeholder replace a resolved author', () => {
    storePosts([post('p1', { author: 'ada' })] as never);

    // An Oxy outage hydrates the author degraded, with no `updatedAt`.
    storePosts([
      {
        ...post('p2', { author: 'ada' }),
        user: { id: 'ada', username: '', name: { displayName: 'Unknown user' }, avatar: null },
      },
    ] as never);

    expect(getPost('p2')?.user).toMatchObject({
      username: 'ada',
      name: { displayName: 'ADA' },
      avatar: 'before',
    });
  });

  it('keeps each account’s people to that account', () => {
    const alice = new Store();
    const bob = new Store();
    withStore(alice, () => {
      storePosts([post('p1', { author: 'ada' })] as never);
      edit('ada', 'after');
    });
    withStore(bob, () => storePosts([post('p1', { author: 'ada' })] as never));

    expect(withStore(alice, () => getPost('p1')?.user.avatar)).toBe('after');
    expect(withStore(bob, () => getPost('p1')?.user.avatar)).toBe('before');
  });
});

describe('a row’s own copy of a person', () => {
  const snapshot = { id: 'ada', avatar: 'row', role: 'owner', updatedAt: HYDRATED_AT };

  it('is laid over by the held copy when that is not older, keeping its own fields', () => {
    const held = person('ada', 'held', EDITED_AT) as HeldUser;
    expect(withHeldUser(snapshot, held)).toEqual({ ...snapshot, ...held, role: 'owner' });
  });

  it('stands when the held copy is older', () => {
    const held = person('ada', 'held', '2026-07-01T00:00:00.000Z') as HeldUser;
    expect(withHeldUser(snapshot, held)).toBe(snapshot);
  });

  it('stands against a held copy Oxy never dated (the placeholder)', () => {
    const placeholder = { id: 'ada', username: '', name: { displayName: 'Unknown user' } };
    expect(currentHeldUser(snapshot, placeholder as HeldUser)).toBeUndefined();
    expect(currentHeldUser({ id: 'ada' }, placeholder as HeldUser)).toBeUndefined();
  });

  it('is laid over by any dated held copy when it carries no date itself', () => {
    const held = person('ada', 'held') as HeldUser;
    expect(withHeldUser({ id: 'ada', avatar: 'row' }, held).avatar).toBe('held');
  });
});

describe('useHeldUsers', () => {
  const seen: ReadonlyMap<string, HeldUser>[] = [];
  function Probe({ ids }: { ids: (string | undefined)[] }) {
    seen.push(useHeldUsers(ids));
    return null;
  }

  afterEach(() => {
    seen.length = 0;
  });

  it('reads the people it names and wakes only when one of them changes', () => {
    storeUsers([person('ada', 'a'), person('bob', 'b')]);
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      renderer = TestRenderer.create(<Probe ids={['ada', undefined, 'ada', 'nobody']} />);
    });
    const first = seen.at(-1);
    expect([...(first?.keys() ?? [])]).toEqual(['ada']);
    const renders = seen.length;

    act(() => edit('bob', 'b2'));
    expect(seen.length).toBe(renders);

    act(() => edit('ada', 'a2'));
    expect(seen.at(-1)?.get('ada')?.avatar).toBe('a2');

    act(() => storeUsers(person('nobody', 'n', EDITED_AT)));
    expect(seen.at(-1)?.get('nobody')?.avatar).toBe('n');

    act(() => renderer?.unmount());
  });
});
