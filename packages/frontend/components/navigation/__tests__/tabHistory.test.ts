import { createInitialState } from 'expo-router/build/react-navigation/core/createInitialState';
import { isActionHandled } from 'expo-router/build/react-navigation/routers/utils';
import { type ExpoTabActionType, ExpoTabRouter } from 'expo-router/build/ui/TabRouter';

import { stateLeavingTab } from '@/components/navigation/tabHistory';
import { PAGES } from '@/components/navigation/tabs';

/**
 * After a publish the composer tab must be GONE, not one Back away.
 *
 * OxyHQ/Mention#1140: after publishing, going Home and moving between tabs
 * landed back on the "New post" composer still holding the published text. The
 * tabs navigator keeps a back history (`backBehavior: 'history'`), and a plain
 * switch only re-orders it — the composer stayed in it. These run the leave
 * through expo-router's REAL tab router, so what is pinned is what Back does,
 * not what a helper returns.
 */

const routeNames = PAGES.map((page) => page.name);

const routerOptions = {
  routeNames,
  routeGetIdList: {},
};

const router = ExpoTabRouter({ backBehavior: 'history', triggerMap: {} });

type TabState = Parameters<typeof router.getStateForAction>[0];

/** The router's next state, failing the test when it refuses the action. */
function act(state: TabState, action: ExpoTabActionType): TabState {
  const result = router.getStateForAction(state, action, { ...routerOptions });
  if (!isActionHandled(result)) throw new Error(`the router refused ${action.type}`);
  return result.state;
}

/**
 * The tabs state after visiting `names` in order, starting from Home, with every
 * page's route preloaded the way the tabs layout does at mount.
 */
function visit(...names: string[]) {
  let state = createInitialState<TabState>({
    routeNames,
    initialRouteName: 'index',
    parentChain: 'tabs',
  });
  for (const name of routeNames) {
    state = act(state, { type: 'PRELOAD', payload: { name } });
  }
  for (const name of names) {
    state = act(state, { type: 'JUMP_TO', payload: { name } });
  }
  return state;
}

const focusedName = (state: { index: number; routes: readonly { name: string }[] }) =>
  state.routes[state.index]?.name;

describe('stateLeavingTab', () => {
  it('focuses the destination', () => {
    const state = visit('videos', 'write');
    const next = stateLeavingTab(state, 'write', 'index');
    expect(next && focusedName(next)).toBe('index');
  });

  it('refuses a page the navigator has no route for', () => {
    const state = visit('write');
    expect(stateLeavingTab(state, 'write', 'nowhere')).toBeNull();
    expect(stateLeavingTab(state, 'nowhere', 'index')).toBeNull();
  });

  it('shows why: a plain switch leaves the composer one Back away', () => {
    const state = visit('videos', 'write');
    const switched = act(state, { type: 'JUMP_TO', payload: { name: 'index' } });
    const back = act(switched, { type: 'GO_BACK' });
    expect(focusedName(back)).toBe('write');
  });

  it('takes the composer out of the back history, through the real router', () => {
    const state = visit('videos', 'write');
    const leaving = stateLeavingTab(state, 'write', 'index');
    if (!leaving) throw new Error('the leave was refused');
    const left = act(state, { type: 'RESET', payload: leaving });

    expect(focusedName(left)).toBe('index');

    // Back walks the tabs the reader visited — and the composer is not one.
    const back = act(left, { type: 'GO_BACK' });
    expect(focusedName(back)).toBe('videos');
    const keys = (left.history ?? []).map((entry) => (entry as { key: string }).key);
    const writeKey = left.routes.find((route) => route.name === 'write')?.key;
    expect(keys).not.toContain(writeKey);
  });
});
