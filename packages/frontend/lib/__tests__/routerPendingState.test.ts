/** Execute Expo Router's installed hook, including its listener lifecycle. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

type State = { routes: Array<{ key: string; name: string; state?: State }> };

function readStateThroughRouter(
  state: State,
  listeners: Record<string, (() => State | undefined) | undefined>,
) {
  let readState: (() => State) | undefined;
  const builderContext = {};
  const routeContext = {};
  const React = {
    use: (context: unknown) =>
      context === builderContext
        ? {
            addKeyedListener: (_type: string, _key: string, listener: () => State) => {
              readState = listener;
            },
          }
        : undefined,
    useCallback: (callback: unknown) => callback,
    useEffect: (effect: () => void) => effect(),
  };
  const exports: Record<string, any> = {};
  const source = fs.readFileSync(
    path.join(
      path.dirname(require.resolve('expo-router/package.json')),
      'build/react-navigation/core/useOnGetState.js',
    ),
    'utf8',
  );
  vm.runInNewContext(
    source,
    {
      exports,
      require: (name: string) => {
        if (name === 'react') return React;
        if (name === './NavigationBuilderContext')
          return { NavigationBuilderContext: builderContext };
        if (name === './NavigationProvider') return { NavigationRouteContext: routeContext };
        if (name === './isArrayEqual')
          return {
            isArrayEqual: (a: unknown[], b: unknown[]) =>
              a.length === b.length && a.every((item, index) => item === b[index]),
          };
        throw new Error(`Unexpected Expo Router hook dependency: ${name}`);
      },
    },
    { filename: 'expo-router/useOnGetState.js' },
  );
  exports.useOnGetState({ getState: () => state, getStateListeners: listeners });
  if (!readState) throw new Error('Expo Router did not register its state getter');
  return readState;
}

const profileState: State = { routes: [{ key: 'profile', name: '[username]' }] };
const initialState: State = { routes: [{ key: 'root', name: '__root', state: profileState }] };

describe('Expo Router pending child navigation state', () => {
  it('retains the deep link while its child navigator has never registered', () => {
    expect(readStateThroughRouter(initialState, {})()).toBe(initialState);
  });

  it('uses the mounted navigator state, then clears it after unregistering', () => {
    const updatedState: State = { routes: [{ key: 'home', name: 'index' }] };
    const listeners: Record<string, (() => State | undefined) | undefined> = {};
    const readState = readStateThroughRouter(initialState, listeners);
    expect(readState().routes[0].state).toBe(profileState);
    listeners.root = () => updatedState;
    expect(readState().routes[0].state).toBe(updatedState);
    listeners.root = undefined;
    expect(readState().routes[0].state).toBeUndefined();
  });

  it('does not restore a stale deep link when a registered navigator returns undefined', () => {
    expect(
      readStateThroughRouter(initialState, { root: () => undefined })().routes[0].state,
    ).toBeUndefined();
  });

  it('does not invent state for a leaf or a fresh route after a reset', () => {
    const reset: State = { routes: [{ key: 'reset', name: 'index' }] };
    expect(readStateThroughRouter(reset, { root: undefined })()).toBe(reset);
  });
});

type MatchingState = {
  key?: string;
  index?: number;
  stale?: boolean;
  routes: Array<{ key?: string; state?: MatchingState }>;
};

function matchingStates(a: MatchingState, b: MatchingState) {
  const exports: {
    read?: (
      a: MatchingState,
      b: MatchingState,
    ) => [MatchingState | undefined, MatchingState | undefined];
  } = {};
  const source = fs.readFileSync(
    path.join(
      path.dirname(require.resolve('expo-router/package.json')),
      'build/fork/useLinking.js',
    ),
    'utf8',
  );
  // Exercise the private matcher from the actual patched module without
  // mounting a NavigationContainer; do not duplicate its implementation.
  vm.runInNewContext(
    `${source}\nexports.read = findMatchingState;`,
    {
      exports,
      require: () => ({}),
    },
    { filename: 'expo-router/useLinking.js' },
  );
  if (!exports.read) throw new Error('Expo Router history matcher missing');
  return exports.read(a, b);
}

describe('Expo Router history reconciliation during pending child boot', () => {
  it('treats unhydrated nested states as a replacement, without poisoning the history queue', () => {
    const pending: MatchingState = { routes: [{}] };
    const root: MatchingState = {
      key: 'root',
      index: 0,
      stale: false,
      routes: [{ key: 'layout', state: pending }],
    };
    expect(matchingStates(root, root)).toEqual([undefined, undefined]);
  });

  it('does not match a stale state that happens to retain its old key', () => {
    const pending: MatchingState = { key: 'old', stale: true, routes: [{}] };
    expect(matchingStates(pending, pending)).toEqual([undefined, undefined]);
  });

  it('still identifies the hydrated child stack for push and back navigation', () => {
    const before: MatchingState = {
      key: 'child',
      index: 0,
      stale: false,
      routes: [{ key: 'profile' }],
    };
    const after: MatchingState = {
      key: 'child',
      index: 1,
      stale: false,
      routes: [{ key: 'profile' }, { key: 'media' }],
    };
    const root = (state: MatchingState): MatchingState => ({
      key: 'root',
      index: 0,
      stale: false,
      routes: [{ key: 'layout', state }],
    });
    expect(matchingStates(root(before), root(after))).toEqual([before, after]);
    expect(matchingStates(root(after), root(before))).toEqual([after, before]);
  });
});
