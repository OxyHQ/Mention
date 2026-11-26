/**
 * Mention's query cache stays strictly per account on Services 15, where
 * Mention owns its React Query client and follows the session itself
 * (`lib/accountScope.ts`).
 *
 * This runs the app's own wiring: the module `queryClient` and
 * `followOxyRuntime`. Only the session runtime and the per-account API are
 * fakes. The probe stays mounted across the switch (the harder case: in the
 * app `AccountSwitchReset` also remounts the tree), and its key is NOT scoped
 * by viewer, so it is the key a leak would show on. The story: A reads; a read
 * for A is still in flight when the session switches to B; A's late answer
 * lands; B reads its own; sign-out.
 */
import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { currentAccountId, followOxyRuntime, resetAccountScopeForTests } from '@/lib/accountScope';
import { queryClient } from '@/lib/queryClient';
import { createRuntime, type Deferred, deferred } from '@/test-support/accountIsolation';

const answers = new Map<string, () => Promise<string>>();

function Probe() {
  const read = useQuery({
    queryKey: ['shared-root'],
    // The session's credentials at the time of the read: the account now.
    queryFn: () => {
      const answer = answers.get(currentAccountId() ?? 'anon');
      return answer ? answer() : Promise.resolve('anon-public');
    },
    retry: false,
  });
  return <Text testID="probe">{read.data ?? ''}</Text>;
}

/** Everything the client holds right now, whatever key it sits under. */
const held = () =>
  JSON.stringify([
    ...queryClient
      .getQueryCache()
      .getAll()
      .map((query) => [query.queryKey, query.state.data]),
    ...queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => [mutation.state.variables, mutation.state.data]),
  ]);

/** Lets React Query's scheduled notifications (a `setTimeout`) reach React. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

afterEach(() => {
  answers.clear();
  queryClient.clear();
  resetAccountScopeForTests();
});

it('never lets account A’s data show or stay in memory for B: switch, late answer, sign-out', async () => {
  const runtime = createRuntime('A');
  const signedOut: string[] = [];
  const unfollow = followOxyRuntime(runtime, queryClient, (id) => signedOut.push(id));
  answers.set('A', () => Promise.resolve('A-private'));

  let view!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    view = TestRenderer.create(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  await settle();
  const shown = () => view.root.findByProps({ testID: 'probe' }).props.children;
  expect(shown()).toBe('A-private');

  // A read for A is still in flight when the session moves to B.
  const late: Deferred<string> = deferred();
  answers.set('A', () => late.promise);
  await act(async () => {
    void queryClient.invalidateQueries({ queryKey: ['shared-root'] });
  });
  const bAnswer: Deferred<string> = deferred();
  answers.set('B', () => bAnswer.promise);
  act(() => runtime.become('B'));

  // The first frame for B: nothing of A's is rendered or held, anywhere.
  expect(shown()).toBe('');
  expect(held()).not.toContain('A-private');

  // A's late answer lands after the switch: it reaches neither the screen nor
  // B's cache.
  await act(async () => {
    late.resolve('A-private-late');
    await late.promise;
  });
  await settle();
  expect(shown()).toBe('');
  expect(held()).not.toContain('A-private');

  // B reads its own.
  await act(async () => {
    bAnswer.resolve('B-own');
    await bAnswer.promise;
  });
  await settle();
  expect(shown()).toBe('B-own');
  expect(held()).not.toContain('A-private');

  // Sign-out: nothing private on screen or in memory, and the account that
  // left is handed over for its stored data to be deleted (not on a switch).
  act(() => runtime.become(null));
  expect(held()).not.toContain('B-own');
  expect(held()).not.toContain('A-private');
  expect(shown()).not.toContain('B-own');
  expect(signedOut).toEqual(['B']);

  await settle();
  view.unmount();
  unfollow();
});

it('drops every query and mutation record synchronously, before anybody is told', () => {
  const runtime = createRuntime('A');
  const unfollow = followOxyRuntime(runtime, queryClient);
  queryClient.setQueryData(['viewer', 'A', 'settings'], 'A-private-settings');
  queryClient.setQueryData(['mention', 'public', 'trends'], 'A-read-trends');
  queryClient.getMutationCache().build(queryClient, { mutationKey: ['m'] });

  let seenByListener = 'unset';
  runtime.subscribe(() => {
    seenByListener = held();
  });
  runtime.become('B');

  // The scope listens first (it subscribed first, as `AccountScopeFollower`
  // does as OxyProvider's first child), so every later listener already sees
  // an empty cache.
  expect(seenByListener).toBe('[]');
  expect(held()).toBe('[]');
  unfollow();
});
