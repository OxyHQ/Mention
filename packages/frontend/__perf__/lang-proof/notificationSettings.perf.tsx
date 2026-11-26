import { Profiler, useState, type ProfilerOnRenderCallback } from 'react';
import { View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { BloomProvider } from '@oxy.so/bloom/provider';

import { appI18n, initializeI18n } from '@/lib/i18n';
import {
  navigations,
  savedPatches,
  setProofBranch,
  setSaveMode,
  settleSave,
  type ProofBranch,
} from './fixture';
import { PROOF_SCREENS, loadScreen, type ProofScreen } from './screens';

/**
 * DEV ONLY. The Bloom language proof's cost harness for Settings ->
 * Notifications (`__perf__/lang-proof/README.md`). Run with
 * `bun run test:perf __perf__/lang-proof`. It measures the three forms of the
 * screen (`./screens.tsx`: `original`, `cleaned`, `bloom`; `PROOF_SCREEN=a,b`
 * picks some) in one process, interleaved run by run in a rotating order, so
 * the machine's load falls on each alike.
 *
 * Mounts the REAL screen under Mention's real Bloom provider, i18n and React
 * Query. Replaced: the three app hooks the screen reads, by the same
 * deterministic stand-ins the web proof app uses (`./fixture.ts`), and the
 * toast, which is recorded (it draws outside the screen).
 *
 * Measures, per branch (pending, signed out, loading, loaded, saving):
 *   - fibers, hook slots and context reads under the screen's root (the walk
 *     Bloom's cost gate does, `packages/bloom-language/parity/cost.parity.test.tsx`);
 * and in the loaded branch:
 *   - mount: wall time of the `act` that mounts the screen, and the Profiler's
 *     actualDuration, median and p95 over RUNS mounts after WARMUP (the
 *     provider stays mounted; only the screen mounts);
 *   - update: a toggle press (the `saving` render, the preference painted at
 *     once) and the save settling (`saving` false), each an `act`: its wall
 *     time and the Profiler's actualDuration, median and p95. The settle's wall
 *     time includes the async `act`'s own scheduling; its actualDuration is the
 *     render alone.
 * Milliseconds are Jest on a development React: relative evidence for TS
 * against `.bloom` on the same machine, not device frame times. Results land
 * in `__perf__/lang-proof/results/compare.json` (`PROOF_OUT` to rename).
 */

const SCREENS = (process.env.PROOF_SCREEN ?? PROOF_SCREENS.join(',')).split(',') as ProofScreen[];
for (const screen of SCREENS) {
  if (!PROOF_SCREENS.includes(screen)) throw new Error(`Unknown PROOF_SCREEN ${screen}`);
}
const RUNS = Number(process.env.PROOF_PERF_RUNS ?? 200);
const WARMUP = Number(process.env.PROOF_PERF_WARMUP ?? 30);

// The same stand-ins the web proof app resolves these to (`./metro.js`).
jest.mock('@oxy.so/services/ui/client', () => require('./stand-ins/services'));
jest.mock('@/hooks/useViewerSettings', () => require('./stand-ins/viewerSettings'));
jest.mock('@/context/MentionSettingsContext', () => require('./stand-ins/settingsRouter'));
jest.mock('@oxy.so/bloom/toast', () => {
  const calls: unknown[][] = [];
  return { __calls: calls, toast: (...args: unknown[]) => calls.push(args) };
});

const toastCalls: unknown[][] = require('@oxy.so/bloom/toast').__calls;

// ── The cost walk ─────────────────────────────────────────────────

interface Fiber {
  tag: number;
  child: Fiber | null;
  sibling: Fiber | null;
  return: Fiber | null;
  stateNode: { current?: Fiber } | null;
  memoizedProps: Record<string, unknown> | null;
  memoizedState: { next: unknown } | null;
  dependencies?: { firstContext: { next: unknown } | null } | null;
}

interface Cost {
  fibers: number;
  hostFibers: number;
  hooks: number;
  contexts: number;
}

/** React's function-component tags (Function, ForwardRef, Memo, SimpleMemo): the fibers that hold hooks. */
const HOOK_TAGS = new Set([0, 11, 14, 15]);
const HOST_COMPONENT = 5;

function rootFiber(renderer: TestRenderer.ReactTestRenderer): Fiber {
  let top = (renderer.root as unknown as { _fiber: Fiber })._fiber;
  while (top.return) top = top.return;
  return top.stateNode?.current ?? top;
}

/** Depth-first, every fiber under (not including) `from`. */
function* under(from: Fiber | null): Generator<Fiber> {
  const stack: Fiber[] = from?.child ? [from.child] : [];
  for (let fiber = stack.pop(); fiber; fiber = stack.pop()) {
    yield fiber;
    if (fiber.sibling) stack.push(fiber.sibling);
    if (fiber.child) stack.push(fiber.child);
  }
}

function marker(renderer: TestRenderer.ReactTestRenderer): Fiber {
  const root = rootFiber(renderer);
  for (const fiber of under(root)) {
    if (fiber.tag === HOST_COMPONENT && fiber.memoizedProps?.testID === 'measured') return fiber;
  }
  throw new Error('No measured marker');
}

/** What the screen costs React: everything under the marker the harness draws it in. */
function cost(renderer: TestRenderer.ReactTestRenderer): Cost {
  const result: Cost = { fibers: 0, hostFibers: 0, hooks: 0, contexts: 0 };
  for (const fiber of under(marker(renderer))) {
    result.fibers += 1;
    if (fiber.tag === HOST_COMPONENT) result.hostFibers += 1;
    if (HOOK_TAGS.has(fiber.tag))
      for (let hook = fiber.memoizedState; hook; hook = hook.next as Fiber['memoizedState'])
        result.hooks += 1;
    for (let read = fiber.dependencies?.firstContext ?? null; read; read = read.next as typeof read)
      result.contexts += 1;
  }
  return result;
}

/** The props of every committed host or composite whose props match. */
function propsWhere(
  renderer: TestRenderer.ReactTestRenderer,
  test: (props: Record<string, unknown>) => boolean,
): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  for (const fiber of under(marker(renderer))) {
    if (fiber.memoizedProps && test(fiber.memoizedProps)) found.push(fiber.memoizedProps);
  }
  return found;
}

const SWITCH = (props: Record<string, unknown>) =>
  (props.role === 'switch' || props.accessibilityRole === 'switch') &&
  (typeof props.onPress === 'function' || typeof props.onValueChange === 'function');

/** Presses the n-th switch (0: push, 1: likes, ...), as a tap does. */
function pressSwitch(renderer: TestRenderer.ReactTestRenderer, index: number) {
  const target = propsWhere(renderer, SWITCH)[index];
  if (!target) throw new Error(`No switch ${index}`);
  if (typeof target.onValueChange === 'function') {
    const checked = (target.value ??
      (target.accessibilityState as { checked?: boolean } | undefined)?.checked) as boolean;
    (target.onValueChange as (v: boolean) => void)(!checked);
  } else (target.onPress as () => void)();
}

/**
 * Whether the `saving` indicator is drawn: Bloom's inline `Loading`, read by the
 * props it is drawn with (the language may call the component in place, so no
 * fiber carries its name).
 */
function isSaving(renderer: TestRenderer.ReactTestRenderer): boolean {
  return (
    propsWhere(renderer, (props) => props.variant === 'inline' && props.size === 'sm').length > 0
  );
}

// ── The harness ───────────────────────────────────────────────────

const draws = Object.fromEntries(SCREENS.map((screen) => [screen, loadScreen(screen)])) as Record<
  ProofScreen,
  ReturnType<typeof loadScreen>
>;
const handle: { show: (screen: ProofScreen | null) => void } = { show: () => undefined };
let profiled = 0;
const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  profiled += actualDuration;
};

function Host() {
  const [screen, setScreen] = useState<ProofScreen | null>(null);
  handle.show = setScreen;
  return (
    <View testID="measured">
      {screen ? (
        <Profiler key={screen} id={screen} onRender={onRender}>
          {draws[screen]()}
        </Profiler>
      ) : null}
    </View>
  );
}

/** The provider tree with nothing in it; `handle.show` mounts a screen. */
function mountHost(): TestRenderer.ReactTestRenderer {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <BloomProvider fonts={false} haptics={false} defaultMode="light">
        <QueryClientProvider client={queryClient}>
          <I18nextProvider i18n={appI18n}>
            <Host />
          </I18nextProvider>
        </QueryClientProvider>
      </BloomProvider>,
    );
  });
  return renderer;
}

function mount(screen: ProofScreen): TestRenderer.ReactTestRenderer {
  const renderer = mountHost();
  act(() => handle.show(screen));
  return renderer;
}

/** The screens in a different order each run, so none always goes first. */
const rotation = (run: number) => SCREENS.map((_, i) => SCREENS[(i + run) % SCREENS.length]);

const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
const quantile = (values: number[], q: number) => {
  const s = sorted(values);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const ms = (value: number) => Math.round(value * 1000) / 1000;
const summary = (values: number[]) => ({
  median: ms(quantile(values, 0.5)),
  p95: ms(quantile(values, 0.95)),
  min: ms(sorted(values)[0]),
});

type Branch = ProofBranch | 'saving';
const results: {
  meta: Record<string, unknown>;
  cost: Partial<Record<ProofScreen, Partial<Record<Branch, Cost>>>>;
  timing: Partial<Record<ProofScreen, Record<string, unknown>>>;
} = {
  meta: {
    screens: SCREENS,
    runtime: `node ${process.version}, jest-expo (${process.env.EXPO_OS ?? 'ios'}), React development build`,
    machine: `${cpus()[0]?.model ?? 'unknown cpu'} x${cpus().length}`,
    compiler: require('@oxy.so/bloom-language-compiler/package.json').version,
    runs: RUNS,
    warmup: WARMUP,
    note: 'interleaved per run in a rotating order; ms are relative Jest timings, not device frame times; cost counts are exact',
  },
  cost: {},
  timing: {},
};

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await initializeI18n();
});

afterAll(() => {
  const dir = join(__dirname, 'results');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, process.env.PROOF_OUT ?? 'compare.json'),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  console.log(JSON.stringify(results, null, 2));
});

describe.each(SCREENS.map((screen) => [screen]))('notification settings (%s)', (screen) => {
  it.each<[ProofBranch]>([['pending'], ['signedOut'], ['loading'], ['loaded']])(
    'costs, %s',
    (branch) => {
      setProofBranch(branch);
      const renderer = mount(screen);
      results.cost[screen] = { ...results.cost[screen], [branch]: cost(renderer) };
      act(() => renderer.unmount());
    },
  );

  it('behaves: a toggle saves its key, Open navigates, a failed save says so', async () => {
    setProofBranch('loaded');
    setSaveMode('hold');
    savedPatches.length = 0;
    navigations.length = 0;
    toastCalls.length = 0;
    const renderer = mount(screen);
    expect(propsWhere(renderer, SWITCH)).toHaveLength(7);
    expect(isSaving(renderer)).toBe(false);

    act(() => pressSwitch(renderer, 1));
    expect(savedPatches).toEqual([{ likes: false }]);
    expect(isSaving(renderer)).toBe(true);
    results.cost[screen] = { ...results.cost[screen], saving: cost(renderer) };
    await act(async () => settleSave('resolve'));
    expect(isSaving(renderer)).toBe(false);

    act(() => pressSwitch(renderer, 2));
    expect(savedPatches[1]).toEqual({ boosts: true });
    await act(async () => settleSave('reject'));
    expect(isSaving(renderer)).toBe(false);
    expect(toastCalls).toHaveLength(1);
    expect(toastCalls[0]?.[1]).toEqual({ type: 'error' });

    const open = propsWhere(
      renderer,
      (props) =>
        props.accessibilityLabel === 'Activity notifications' &&
        typeof props.onPress === 'function',
    )[0];
    if (!open) throw new Error('No Open button');
    act(() => (open.onPress as () => void)());
    expect(navigations).toEqual(['/settings/notifications/subscriptions']);
    act(() => renderer.unmount());
  });
});

describe('notification settings, timed together', () => {
  it('times mount and update', async () => {
    setProofBranch('loaded');
    setSaveMode('hold');
    const renderer = mountHost();
    const series = () => Object.fromEntries(SCREENS.map((s) => [s, [] as number[]]));
    const mountWall = series();
    const mountProfiled = series();
    const pressWall = series();
    const pressProfiled = series();
    const settleWall = series();
    const settleProfiled = series();
    const updateWall = series();

    for (let run = 0; run < WARMUP + RUNS; run += 1) {
      for (const screen of rotation(run)) {
        act(() => handle.show(null));
        profiled = 0;
        const start = performance.now();
        act(() => handle.show(screen));
        const wall = performance.now() - start;
        if (run >= WARMUP) {
          mountWall[screen].push(wall);
          mountProfiled[screen].push(profiled);
        }
      }
    }

    for (let run = 0; run < WARMUP + RUNS; run += 1) {
      for (const screen of rotation(run)) {
        act(() => handle.show(screen));
        profiled = 0;
        const start = performance.now();
        act(() => pressSwitch(renderer, 1));
        const pressed = performance.now();
        const pressRender = profiled;
        profiled = 0;
        await act(async () => settleSave('resolve'));
        const settled = performance.now();
        expect(isSaving(renderer)).toBe(false);
        act(() => handle.show(null));
        if (run >= WARMUP) {
          pressWall[screen].push(pressed - start);
          pressProfiled[screen].push(pressRender);
          settleWall[screen].push(settled - pressed);
          settleProfiled[screen].push(profiled);
          updateWall[screen].push(settled - start);
        }
      }
    }
    act(() => renderer.unmount());

    for (const screen of SCREENS) {
      results.timing[screen] = {
        mountWall: summary(mountWall[screen]),
        mountProfilerActual: summary(mountProfiled[screen]),
        togglePressWall: summary(pressWall[screen]),
        togglePressProfilerActual: summary(pressProfiled[screen]),
        saveSettleWall: summary(settleWall[screen]),
        saveSettleProfilerActual: summary(settleProfiled[screen]),
        updateTotalWall: summary(updateWall[screen]),
      };
    }
  }, 1_800_000);
});
