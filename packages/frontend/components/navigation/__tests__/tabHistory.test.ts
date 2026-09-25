import { ExpoTabRouter } from 'expo-router/build/ui/TabRouter';

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

function makeRouter() {
  return ExpoTabRouter({ backBehavior: 'history', triggerMap: {} });
}

const routerOptions = {
  routeNames,
  routeParamList: Object.fromEntries(routeNames.map((name) => [name, undefined])),
  routeGetIdList: {},
};

/** The tabs state after visiting `names` in order, starting from Home. */
function visit(...names: string[]) {
  const router = makeRouter();
  let state = router.getInitialState({ ...routerOptions });
  for (const name of names) {
    const next = router.getStateForAction(
      state,
      { type: 'JUMP_TO', payload: { name } },
      { ...routerOptions },
    );
    if (!next) throw new Error(`the router refused to jump to ${name}`);
    state = next as typeof state;
  }
  return { router, state };
}

const focusedName = (state: { index: number; routes: readonly { name: string }[] }) =>
  state.routes[state.index]?.name;

describe('stateLeavingTab', () => {
  it('focuses the destination', () => {
    const { state } = visit('videos', 'write');
    const next = stateLeavingTab(state, 'write', 'index');
    expect(next && focusedName(next)).toBe('index');
  });

  it('refuses a page the navigator has no route for', () => {
    const { state } = visit('write');
    expect(stateLeavingTab(state, 'write', 'nowhere')).toBeNull();
    expect(stateLeavingTab(state, 'nowhere', 'index')).toBeNull();
  });

  it('shows why: a plain switch leaves the composer one Back away', () => {
    const { router, state } = visit('videos', 'write');
    const switched = router.getStateForAction(
      state,
      { type: 'JUMP_TO', payload: { name: 'index' } },
      { ...routerOptions },
    );
    const back = router.getStateForAction(switched as typeof state, { type: 'GO_BACK' }, { ...routerOptions });
    expect(back && focusedName(back as typeof state)).toBe('write');
  });

  it('takes the composer out of the back history, through the real router', () => {
    const { router, state } = visit('videos', 'write');
    const leaving = stateLeavingTab(state, 'write', 'index');
    if (!leaving) throw new Error('the leave was refused');
    const left = router.getStateForAction(
      state,
      { type: 'RESET', payload: leaving },
      { ...routerOptions },
    ) as typeof state;

    expect(focusedName(left)).toBe('index');

    // Back walks the tabs the reader visited — and the composer is not one.
    const back = router.getStateForAction(left, { type: 'GO_BACK' }, { ...routerOptions }) as typeof state;
    expect(focusedName(back)).toBe('videos');
    const keys = (left.history ?? []).map((entry) => (entry as { key: string }).key);
    const writeKey = left.routes.find((route) => route.name === 'write')?.key;
    expect(keys).not.toContain(writeKey);
  });
});
