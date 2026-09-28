import {
  createMentionSearchCache,
  findExactMentionUser,
  resolveTypedMentions,
  toMentionUsers,
  type MentionUser,
} from '../mentionSearch';

const alice: MentionUser = { id: 'alice-id', username: 'alice', displayName: 'Alice' };
const alicia: MentionUser = { id: 'alicia-id', username: 'alicia' };
const bob: MentionUser = { id: 'bob-id', username: 'bob', displayName: '  ' };

/** A lookup over a fixed directory: `undefined` for anything never searched. */
function directory(entries: Record<string, MentionUser | null>) {
  return (handle: string) => entries[handle.toLowerCase()];
}

describe('toMentionUsers', () => {
  it('maps Oxy profiles and drops rows with no id or username', () => {
    expect(
      toMentionUsers([
        { id: 'a', username: 'alice', name: { displayName: 'Alice' }, avatar: 'av', verified: true },
        { _id: 'b', handle: 'bob', profilePicture: 'pic' },
        { id: 'c' },
        { username: 'nobody' },
      ]),
    ).toEqual([
      { id: 'a', username: 'alice', displayName: 'Alice', avatar: 'av', verified: true },
      { id: 'b', username: 'bob', displayName: undefined, avatar: 'pic', verified: false },
    ]);
    expect(toMentionUsers(undefined)).toEqual([]);
  });
});

describe('findExactMentionUser', () => {
  it('matches the username exactly, ignoring case', () => {
    expect(findExactMentionUser([alicia, alice], 'ALICE')).toBe(alice);
    expect(findExactMentionUser([alicia], 'alice')).toBeNull();
  });

  it('refuses to choose between two different accounts', () => {
    const twin = { id: 'other-id', username: 'Alice' };
    expect(findExactMentionUser([alice, twin], 'alice')).toBeNull();
    expect(findExactMentionUser([alice, { ...alice }], 'alice')).toEqual(alice);
  });
});

describe('resolveTypedMentions', () => {
  it('turns a completed handle into a placeholder and its metadata', () => {
    const result = resolveTypedMentions(
      { text: 'hi @Alice and @bob, bye', mentions: [] },
      directory({ alice, bob }),
      { completedOnly: true },
    );
    expect(result).toEqual({
      value: {
        text: 'hi [mention:alice-id] and [mention:bob-id], bye',
        mentions: [
          { userId: 'alice-id', username: 'alice', displayName: 'Alice' },
          { userId: 'bob-id', username: 'bob', displayName: 'bob' },
        ],
      },
      pending: [],
    });
  });

  it('leaves a handle still being typed for the picker unless submitting', () => {
    const value = { text: 'hi @alice', mentions: [] };
    const lookup = directory({ alice });
    expect(resolveTypedMentions(value, lookup, { completedOnly: true }).value).toBe(value);
    expect(resolveTypedMentions(value, lookup, { completedOnly: false }).value.text).toBe(
      'hi [mention:alice-id]',
    );
  });

  it('treats a trailing dot or dash as finishing the handle only once something else follows', () => {
    const lookup = directory({ alice });
    const resolve = (text: string) =>
      resolveTypedMentions({ text, mentions: [] }, lookup, { completedOnly: true }).value.text;
    expect(resolve('hi @alice.')).toBe('hi @alice.');
    expect(resolve('hi @alice. ')).toBe('hi [mention:alice-id]. ');
    expect(resolve('hi @alice-')).toBe('hi @alice-');
    expect(resolve('hi @alice-!')).toBe('hi [mention:alice-id]-!');
    expect(resolve('hi @alice!')).toBe('hi [mention:alice-id]!');
    expect(resolve('hi @alice\nnext')).toBe('hi [mention:alice-id]\nnext');
  });

  it('never touches a handle inside a URL or an email, or a federated handle', () => {
    const lookup = jest.fn(directory({ alice, 'example.com': null }));
    const text = 'see https://x.com/@alice now, mail bob@alice.com or @alice@example.com ok, @alice@';
    const result = resolveTypedMentions({ text, mentions: [] }, lookup, { completedOnly: true });
    expect(result.value.text).toBe(text);
    expect(result.pending).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('reports unanswered handles once each and leaves known misses as text', () => {
    const result = resolveTypedMentions(
      { text: '@carol @carol @dave [mention:alice-id] ', mentions: [] },
      directory({ dave: null }),
      { completedOnly: true },
    );
    expect(result.value.text).toBe('@carol @carol @dave [mention:alice-id] ');
    expect(result.pending).toEqual(['carol']);
  });
});

describe('createMentionSearchCache', () => {
  it('shares one request per query, case-insensitively, and answers from memory after', async () => {
    const fetchUsers = jest.fn(async () => [alice, alicia]);
    const cache = createMentionSearchCache(fetchUsers);

    expect(cache.peek('alice')).toBeUndefined();
    expect(cache.findUser('alice')).toBeUndefined();

    const [first, second] = await Promise.all([cache.search('alice'), cache.search('ALICE')]);
    expect(first).toBe(second);
    await cache.search('Alice');
    expect(fetchUsers).toHaveBeenCalledTimes(1);

    expect(cache.peek('ALICE')).toEqual([alice, alicia]);
    expect(cache.findUser('Alice')).toBe(alice);
  });

  it('answers a handle from a prefix search that already returned the account', async () => {
    const cache = createMentionSearchCache(async () => [alice, alicia]);
    await cache.search('ali');
    expect(cache.findUser('alicia')).toBe(alicia);
    expect(cache.findUser('alfred')).toBeUndefined();
  });

  it('says no match when the exact query was searched and names nobody', async () => {
    const cache = createMentionSearchCache(async () => [alicia]);
    await cache.search('alice');
    expect(cache.findUser('alice')).toBeNull();
  });

  it('forgets a failed search so a later completion can retry', async () => {
    const fetchUsers = jest
      .fn<Promise<MentionUser[]>, [string]>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([alice]);
    const cache = createMentionSearchCache(fetchUsers);

    await expect(cache.search('alice')).rejects.toThrow('offline');
    expect(cache.peek('alice')).toBeUndefined();
    await expect(cache.search('alice')).resolves.toEqual([alice]);
    expect(fetchUsers).toHaveBeenCalledTimes(2);
  });

  it('bounds what it remembers, dropping the oldest query first', async () => {
    const cache = createMentionSearchCache(async (query) => [{ id: query, username: query }]);
    for (let index = 0; index <= 200; index += 1) {
      await cache.search(`user${index}`);
    }
    expect(cache.peek('user0')).toBeUndefined();
    expect(cache.peek('user1')).toBeDefined();
    expect(cache.peek('user200')).toBeDefined();
  });
});
