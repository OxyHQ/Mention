import React, { Profiler, useState, type ProfilerOnRenderCallback } from 'react';
import TestRenderer, { act, type ReactTestRendererJSON } from 'react-test-renderer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { BloomProvider } from '@oxy.so/bloom/provider';

import { appI18n, initializeI18n } from '@/lib/i18n';
import MediaGrid from '../MediaGrid';
import VideosGrid from '../VideosGrid';

/**
 * The profile grid cell-cost harness. Run with `bun run test:perf`.
 *
 * Mounts the REAL Media and Videos grids (their cells, `ProfileGridList`'s
 * native row and `LiveVideoPosterCell`) under the real Bloom provider and i18n.
 * Replaced: the feed hook (it hands the grid its items), the router, and
 * `VirtualList`, which here renders every row it is given — FlashList draws
 * nothing without a native layout, and the cell is what is measured.
 *
 * Per cell, by kind: components (every element instance), hook slots, context
 * reads and host nodes, read as the difference between N and 2N mounted cells,
 * so the grid's own cost cancels out; and the Profiler's actualDuration of the
 * commit that adds N cells, per cell (relative Jest evidence, not device time).
 * Results land in `__perf__/results/latest.json`.
 */

const RUNS = Number(process.env.GRID_PERF_RUNS ?? 7);
const N = Number(process.env.GRID_PERF_CELLS ?? 30);

const mockFeed: { items: unknown[] } = { items: [] };

jest.mock('../useProfileMediaFeed', () => ({
  useProfileMediaFeed: () => ({
    primaryFeed: { isLoading: false },
    postsFeed: null,
    items: mockFeed.items,
    loadMore: () => undefined,
    restorationKey: 'perf',
  }),
}));

jest.mock('@/lib/navigation/router', () => {
  const router = { push: () => undefined, back: () => undefined, replace: () => undefined };
  return { useRouter: () => router, router };
});

jest.mock('@oxy.so/bloom/list', () => {
  const React = require('react');
  return {
    ...jest.requireActual('@oxy.so/bloom/list'),
    VirtualList: ({
      data,
      renderItem,
      keyExtractor,
    }: {
      data: unknown[];
      renderItem: (info: { item: unknown; index: number }) => React.ReactNode;
      keyExtractor: (item: unknown, index: number) => string;
    }) =>
      React.createElement(
        React.Fragment,
        null,
        data.map((item, index) =>
          React.createElement(
            React.Fragment,
            { key: keyExtractor(item, index) },
            renderItem({ item, index }),
          ),
        ),
      ),
  };
});

type Kind = 'mediaImage' | 'mediaCarousel' | 'mediaVideo' | 'videosVideo';
const KINDS: Kind[] = ['mediaImage', 'mediaCarousel', 'mediaVideo', 'videosVideo'];

const image = (id: string, i: number) => ({
  id: `${id}-m${i}`,
  url: `https://cdn.test/${id}-${i}.jpg`,
  thumbUrl: `https://cdn.test/${id}-${i}-thumb.jpg`,
  type: 'image',
});
const video = (id: string) => ({
  id: `${id}-v`,
  url: `https://cdn.test/${id}.mp4`,
  thumbUrl: `https://cdn.test/${id}-poster.jpg`,
  type: 'video',
  durationSec: 42,
});

/** Posts that yield exactly `count` cells of `kind`. */
function makeItems(kind: Kind, tag: string, count: number): unknown[] {
  const posts: unknown[] = [];
  const perPost = kind === 'mediaCarousel' ? 2 : 1;
  for (let p = 0; p < count / perPost; p += 1) {
    const id = `${tag}-${p}`;
    const media =
      kind === 'mediaImage'
        ? [image(id, 0)]
        : kind === 'mediaCarousel'
          ? [image(id, 0), image(id, 1)]
          : [video(id)];
    posts.push({ id, content: { text: '', media }, engagement: { views: 1200 + p } });
  }
  return posts;
}

interface HarnessHandle {
  setItems: (items: unknown[]) => void;
}

function GridHarness({ kind, handle }: { kind: Kind; handle: HarnessHandle }) {
  const [items, setItems] = useState<unknown[]>([]);
  handle.setItems = setItems;
  mockFeed.items = items;
  // A prop that changes with the items, so the grid re-reads its feed.
  const userId = `perf-${items.length}-${(items[0] as { id?: string } | undefined)?.id ?? ''}`;
  return kind === 'videosVideo' ? (
    <VideosGrid userId={userId} ownsScroll />
  ) : (
    <MediaGrid userId={userId} ownsScroll />
  );
}

function mount(kind: Kind, onRender: ProfilerOnRenderCallback) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const handle: HarnessHandle = { setItems: () => undefined };
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <BloomProvider fonts={false} haptics={false} defaultMode="light">
        <QueryClientProvider client={queryClient}>
          <I18nextProvider i18n={appI18n}>
            <Profiler id="grid" onRender={onRender}>
              <GridHarness kind={kind} handle={handle} />
            </Profiler>
          </I18nextProvider>
        </QueryClientProvider>
      </BloomProvider>,
    );
  });
  return { renderer, handle };
}

function countHostNodes(node: ReactTestRendererJSON | ReactTestRendererJSON[] | null): number {
  if (!node) return 0;
  if (Array.isArray(node)) return node.reduce((sum, child) => sum + countHostNodes(child), 0);
  let count = 1;
  for (const child of node.children ?? []) {
    if (typeof child !== 'string') count += countHostNodes(child);
  }
  return count;
}

interface FiberLike {
  tag: number;
  return: FiberLike | null;
  stateNode: { current?: FiberLike } | null;
  child: FiberLike | null;
  sibling: FiberLike | null;
  memoizedState: { next?: unknown } | null;
  dependencies?: { firstContext?: { next?: unknown } | null } | null;
}

// React's function-component-shaped fiber tags: Function, ForwardRef, Memo, SimpleMemo.
const HOOK_FIBER_TAGS = new Set([0, 11, 14, 15]);

/** Hook slots and context reads committed under the tree (as the feed row harness reads them). */
function countHooksAndContexts(renderer: TestRenderer.ReactTestRenderer) {
  let top = (renderer.root as unknown as { _fiber: FiberLike })._fiber;
  while (top.return) top = top.return;
  const root = top.stateNode?.current ?? top;
  let hooks = 0;
  let contexts = 0;
  const stack: FiberLike[] = [root];
  for (let fiber = stack.pop(); fiber; fiber = stack.pop()) {
    if (HOOK_FIBER_TAGS.has(fiber.tag)) {
      for (let hook = fiber.memoizedState; hook; hook = (hook.next as typeof hook) ?? null)
        hooks += 1;
      for (let dep = fiber.dependencies?.firstContext; dep; dep = (dep.next as typeof dep) ?? null)
        contexts += 1;
    }
    if (fiber.child) stack.push(fiber.child);
    if (fiber.sibling && fiber !== root) stack.push(fiber.sibling);
  }
  return { hooks, contexts };
}

function structure(renderer: TestRenderer.ReactTestRenderer) {
  return {
    components: renderer.root.findAll(() => true, { deep: true }).length,
    hostNodes: countHostNodes(renderer.toJSON()),
    ...countHooksAndContexts(renderer),
  };
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const round = (value: number) => Math.round(value * 1000) / 1000;

const results: { meta: Record<string, unknown>; kinds: Partial<Record<Kind, unknown>> } = {
  meta: {
    runtime: `node ${process.version}, jest-expo (${process.env.EXPO_OS ?? 'ios'}), React dev build`,
    runs: RUNS,
    cells: N,
    note: 'per cell = (2N cells - N cells) / N; ms are relative Jest timings, not device frame times',
  },
  kinds: {},
};

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await initializeI18n();
});

afterAll(() => {
  const dir = join(__dirname, 'results');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, process.env.GRID_PERF_OUT ?? 'latest.json'),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  console.log(JSON.stringify(results, null, 2));
});

describe('profile grid cell cost', () => {
  it.each(KINDS.map((kind) => [kind]))('%s', (kind) => {
    let commitMs = 0;
    const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
      commitMs += actualDuration;
    };
    const { renderer, handle } = mount(kind, onRender);
    const mountMs: number[] = [];
    let perCell: Record<string, number> = {};

    // Run 0 warms module init and style caches; it is measured but discarded.
    for (let run = 0; run <= RUNS; run += 1) {
      const first = makeItems(kind, `${kind}-${run}-a`, N);
      const both = [...first, ...makeItems(kind, `${kind}-${run}-b`, N)];
      act(() => handle.setItems(first));
      const atN = structure(renderer);
      commitMs = 0;
      act(() => handle.setItems(both));
      if (run > 0) mountMs.push(commitMs / N);
      if (run === 1) {
        const at2N = structure(renderer);
        perCell = Object.fromEntries(
          Object.entries(at2N).map(([key, value]) => [
            key,
            round((value - atN[key as keyof typeof atN]) / N),
          ]),
        );
      }
      act(() => handle.setItems([]));
    }
    act(() => renderer.unmount());

    // A harness that drew no cells would look free.
    expect(perCell.hostNodes).toBeGreaterThan(0);
    results.kinds[kind] = {
      ...perCell,
      addMsPerCell: round(median(mountMs)),
    };
  });
});
