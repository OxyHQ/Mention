import { Profiler, useState, type ProfilerOnRenderCallback, type ReactNode } from 'react';
import { View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { BloomProvider } from '@oxy.so/bloom/provider';
import { VStack, toElement } from '@oxy.so/bloom-language';

import { appI18n, initializeI18n } from '@/lib/i18n';
import { ROW_FORMS, ROW_STATES, drawRow, rowProps, type RowForm, type RowName } from './rows/rows';

/**
 * DEV ONLY. The rows proof's cost harness (`README.md`, "Rows"): PostItem's rows
 * that `bloomc migrate` moved to `.bloom`, against the TypeScript they replaced
 * (`rows/rows.tsx`). Run with `bun run test:perf __perf__/lang-proof/rows`.
 *
 * Each row is drawn as PostItem draws it (a language child in its tree), under
 * Mention's real Bloom provider, i18n and React Query; the app router is
 * replaced (a `Link` that draws its child, a `push` that records), the same for
 * both forms. Per row state: fibers, host fibers, hook slots and context reads
 * under the marker (the walk of `notificationSettings.perf.tsx`). Per row: the
 * mount of its first state and the update to its second (a prop change, as
 * PostItem re-renders it), wall time and Profiler actualDuration, median and p95
 * over RUNS after WARMUP, the two forms interleaved in a rotating order.
 * Results land in `results/rows.json` (`PROOF_OUT` to rename).
 */

const RUNS = Number(process.env.PROOF_PERF_RUNS ?? 200);
const WARMUP = Number(process.env.PROOF_PERF_WARMUP ?? 30);

const pushes: string[] = [];
jest.mock('@/lib/navigation/router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
  useRouter: () => ({ push: (href: string) => pushes.push(href) }),
}));

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

const HOOK_TAGS = new Set([0, 11, 14, 15]);
const HOST_COMPONENT = 5;

function rootFiber(renderer: TestRenderer.ReactTestRenderer): Fiber {
  let top = (renderer.root as unknown as { _fiber: Fiber })._fiber;
  while (top.return) top = top.return;
  return top.stateNode?.current ?? top;
}

function* under(from: Fiber | null): Generator<Fiber> {
  const stack: Fiber[] = from?.child ? [from.child] : [];
  for (let fiber = stack.pop(); fiber; fiber = stack.pop()) {
    yield fiber;
    if (fiber.sibling) stack.push(fiber.sibling);
    if (fiber.child) stack.push(fiber.child);
  }
}

function marker(renderer: TestRenderer.ReactTestRenderer): Fiber {
  for (const fiber of under(rootFiber(renderer))) {
    if (fiber.tag === HOST_COMPONENT && fiber.memoizedProps?.testID === 'measured') return fiber;
  }
  throw new Error('No measured marker');
}

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

/** The text a renderer draws, in order. */
function texts(renderer: TestRenderer.ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: TestRenderer.ReactTestRendererJSON | string | null) => {
    if (node == null) return;
    if (typeof node === 'string') return void out.push(node);
    for (const child of node.children ?? [])
      walk(child as TestRenderer.ReactTestRendererJSON | string);
  };
  const json = renderer.toJSON();
  for (const node of Array.isArray(json) ? json : [json]) walk(node);
  return out.join('');
}

type Shown = { form: RowForm; row: RowName; props: Record<string, unknown> } | null;
const handle: { show: (shown: Shown) => void } = { show: () => undefined };
let profiled = 0;
const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  profiled += actualDuration;
};

function Host() {
  const [shown, setShown] = useState<Shown>(null);
  handle.show = setShown;
  return (
    <View testID="measured">
      {shown ? (
        <Profiler key={`${shown.form}:${shown.row}`} id={shown.form} onRender={onRender}>
          {toElement(VStack(drawRow(shown.form, shown.row, shown.props)))}
        </Profiler>
      ) : null}
    </View>
  );
}

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

const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
const quantile = (values: number[], q: number) => {
  const s = sorted(values);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const ms = (value: number) => Math.round(value * 1000) / 1000;
const summary = (values: number[]) => ({
  median: ms(quantile(values, 0.5)),
  p95: ms(quantile(values, 0.95)),
});

const ROWS = [...new Set(ROW_STATES.map((s) => s.row))];
const results: {
  meta: Record<string, unknown>;
  cost: Record<string, Partial<Record<RowForm, Cost>>>;
  timing: Record<string, Partial<Record<RowForm, Record<string, unknown>>>>;
} = {
  meta: {
    runtime: `node ${process.version}, jest-expo (${process.env.EXPO_OS ?? 'ios'}), React development build`,
    machine: `${cpus()[0]?.model ?? 'unknown cpu'} x${cpus().length}`,
    compiler: require('@oxy.so/bloom-language-compiler/package.json').version,
    runs: RUNS,
    warmup: WARMUP,
    note: 'forms interleaved per run in a rotating order; ms are relative Jest timings; cost counts are exact',
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
    join(dir, process.env.PROOF_OUT ?? 'rows.json'),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  console.log(JSON.stringify(results, null, 2));
});

describe.each(ROW_STATES.map((s) => [`${s.row}/${s.state}`, s] as const))('%s', (key, state) => {
  it('costs the same or less, and draws the same text', () => {
    const drawn: Partial<Record<RowForm, string>> = {};
    for (const form of ROW_FORMS) {
      const renderer = mountHost();
      act(() => handle.show({ form, row: state.row, props: rowProps(state) }));
      results.cost[key] = { ...results.cost[key], [form]: cost(renderer) };
      drawn[form] = texts(renderer);
      act(() => renderer.unmount());
    }
    expect(drawn.bloom).toBe(drawn.ts);
    const { ts, bloom } = results.cost[key] as Record<RowForm, Cost>;
    for (const measure of ['fibers', 'hooks', 'contexts'] as const) {
      expect(bloom[measure]).toBeLessThanOrEqual(ts[measure]);
    }
  });
});

describe('rows, timed together', () => {
  it.each(ROWS.map((row) => [row]))('times mount and update: %s', (row) => {
    const [first, second] = ROW_STATES.filter((s) => s.row === row);
    const renderer = mountHost();
    const series = () => Object.fromEntries(ROW_FORMS.map((f) => [f, [] as number[]]));
    const mountWall = series();
    const mountProfiled = series();
    const updateWall = series();
    const updateProfiled = series();
    for (let run = 0; run < WARMUP + RUNS; run += 1) {
      const order = run % 2 === 0 ? ROW_FORMS : [...ROW_FORMS].reverse();
      for (const form of order) {
        act(() => handle.show(null));
        profiled = 0;
        let start = performance.now();
        act(() => handle.show({ form, row, props: rowProps(first) }));
        const mounted = performance.now() - start;
        const mountedProfiled = profiled;
        profiled = 0;
        start = performance.now();
        act(() => handle.show({ form, row, props: rowProps(second) }));
        const updated = performance.now() - start;
        if (run >= WARMUP) {
          mountWall[form].push(mounted);
          mountProfiled[form].push(mountedProfiled);
          updateWall[form].push(updated);
          updateProfiled[form].push(profiled);
        }
      }
    }
    results.timing[row] = Object.fromEntries(
      ROW_FORMS.map((form) => [
        form,
        {
          mountWall: summary(mountWall[form]),
          mountProfiled: summary(mountProfiled[form]),
          updateWall: summary(updateWall[form]),
          updateProfiled: summary(updateProfiled[form]),
        },
      ]),
    );
    act(() => renderer.unmount());
  });
});
