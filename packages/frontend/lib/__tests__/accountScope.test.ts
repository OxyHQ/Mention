import { currentAccountId, followSessionRuntime, subscribeAccount } from '../accountScope';

/** The part of the Services runtime the scope reads, driven by the test. */
function runtimeFor(initial: string | null) {
  let id = initial;
  const listeners = new Set<() => void>();
  return {
    runtime: {
      getSnapshot: () => ({ account: id ? { id } : null }),
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    switchTo(next: string | null) {
      id = next;
      for (const listener of [...listeners]) listener();
    },
    /** A change of the session that moves no account (a token refresh). */
    touch() {
      for (const listener of [...listeners]) listener();
    },
    listening: () => listeners.size,
  };
}

describe('accountScope', () => {
  it('has no account before the provider hands over its runtime', () => {
    expect(currentAccountId()).toBeNull();
  });

  it('reads the account live and tells subscribers about every session change', () => {
    const session = runtimeFor('a');
    const heard: (string | null)[] = [];
    const stopHearing = subscribeAccount(() => heard.push(currentAccountId()));
    const unfollow = followSessionRuntime(session.runtime);

    expect(currentAccountId()).toBe('a');
    session.switchTo('b');
    session.touch();
    session.switchTo(null);
    expect(heard).toEqual(['b', 'b', null]);

    stopHearing();
    session.switchTo('c');
    expect(heard).toHaveLength(3);
    unfollow();
  });

  it('reports the held account and each new one, not an unchanged session', () => {
    const session = runtimeFor('a');
    const accounts: (string | null)[] = [];
    const unfollow = followSessionRuntime(session.runtime, () => accounts.push(currentAccountId()));

    session.touch();
    session.switchTo('b');
    session.switchTo(null);

    expect(accounts).toEqual(['a', 'b', null]);
    unfollow();
  });

  it('refuses a continuation once the provider is gone', () => {
    const session = runtimeFor('a');
    const heard = jest.fn();
    const stopHearing = subscribeAccount(heard);
    const unfollow = followSessionRuntime(session.runtime);

    unfollow();

    expect(currentAccountId()).toBeNull();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(session.listening()).toBe(0);
    stopHearing();
  });

  it('keeps following a newer runtime when an older one lets go', () => {
    const first = runtimeFor('a');
    const second = runtimeFor('b');
    const unfollowFirst = followSessionRuntime(first.runtime);
    const unfollowSecond = followSessionRuntime(second.runtime);

    unfollowFirst();

    expect(currentAccountId()).toBe('b');
    unfollowSecond();
  });
});
