import React, { Profiler, useState, type ProfilerOnRenderCallback } from 'react';
import TestRenderer, { act, type ReactTestRendererJSON } from 'react-test-renderer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { BloomProvider } from '@oxy.so/bloom/provider';
import { router } from 'expo-router';

import { appI18n, initializeI18n } from '@/lib/i18n';
import { usePostsStore } from '@/stores/postsStore';
import { VideoPlaybackProvider, VideoViewabilityProvider } from '@/context/VideoPlaybackContext';
import { renderFeedRow, type PostFeedRow } from '../feedRows';
import { ROW_KINDS, makeRow, type RowKind } from './fixtures';
import budgets from './budgets.json';
import { takeRequests } from '../../../test-support/perfNetwork';
import type { HydratedPost } from '@mention/shared-types';

/**
 * The feed row-cost harness (issue #1103). Run with `bun run test:perf`.
 *
 * Mounts REAL feed rows — `renderFeedRow`, the same function both Feed
 * implementations call — under the real Bloom provider, i18n and React Query,
 * with only native modules and the network replaced (`test-support/perfSetup.ts`).
 *
 * It measures, per row kind:
 *   - mount: JS time to mount a batch of fresh rows, per row (median of runs);
 *   - recycle: time for the SAME row instances to take new posts — what FlashList
 *     does on every fling;
 *   - hostNodes: host primitives the row commits (each one is an interop
 *     component under the NativeWind class-name polyfill);
 *   - hooks / context reads: hook slots and context subscriptions the row's
 *     components hold — the controllers and store subscriptions a row mounts;
 *   - components: every element instance (composite + host) the row mounts —
 *     a deterministic proxy for the JS work a mount does, unlike the ms, which
 *     move with whatever else the machine is running;
 * and, across a mixed feed:
 *   - re-renders of unrelated mounted rows for an unrelated store write, a write
 *     to another post, and a view-count update;
 *   - every network request a mount, a recycle and a simulated fling make, with
 *     translation requests counted separately (they must be zero);
 *   - React Query observers mounted per row.
 *
 * Milliseconds come from Jest on a dev (non-minified) React; they are RELATIVE
 * evidence for before/after on the same machine, not device frame times. The
 * structural numbers (renders, requests, observers, nodes) are exact and gated.
 * Results land in `__perf__/results/latest.json`.
 */

const RUNS = Number(process.env.FEED_PERF_RUNS ?? 7);
const BATCH = Number(process.env.FEED_PERF_BATCH ?? 8);

// ── Harness ───────────────────────────────────────────────────────

type RenderLog = Map<string, number>;

interface HarnessHandle {
  setPosts: (posts: HydratedPost[]) => void;
}

function toRow(post: HydratedPost): PostFeedRow {
  return {
    kind: 'post',
    item: post,
    sliceKey: post.id,
    isThreadParent: false,
    isThreadChild: false,
    isThreadLastChild: false,
    isIncompleteThread: false,
    nestingDepth: 0,
    truncatedChildCount: 0,
  };
}

/**
 * Rows are keyed by CELL, the way FlashList recycles: a post keeps its cell for
 * as long as it stays in the window, and a post entering the window takes over
 * the cell of one that left — re-rendering that row instance with new data
 * instead of mounting a new one.
 */
function FeedHarness({ handle, onRender }: { handle: HarnessHandle; onRender: ProfilerOnRenderCallback }) {
  const [posts, setPosts] = useState<HydratedPost[]>([]);
  const cellsRef = React.useRef(new Map<string, number>());
  handle.setPosts = setPosts;

  const cells = cellsRef.current;
  const ids = new Set(posts.map((post) => post.id));
  const free: number[] = [];
  for (const [id, cell] of cells) {
    if (!ids.has(id)) {
      cells.delete(id);
      free.push(cell);
    }
  }
  free.sort((a, b) => a - b);
  let next = cells.size + free.length;
  for (const post of posts) {
    if (!cells.has(post.id)) cells.set(post.id, free.shift() ?? next++);
  }

  return (
    <>
      {posts.map((post) => (
        <Profiler key={cells.get(post.id)} id={post.boost?.originalPost?.id ?? post.id} onRender={onRender}>
          {renderFeedRow(toRow(post), { router, threadLineColor: '#ccc', feedDescriptor: 'perf' })}
        </Profiler>
      ))}
    </>
  );
}

/** Nothing on screen: the harness measures row construction, not playback. */
const NO_VIEWABLE_KEYS: ReadonlySet<string> = new Set();

function mountHarness() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const handle: HarnessHandle = { setPosts: () => undefined };
  const renders: RenderLog = new Map();
  const onRender: ProfilerOnRenderCallback = (id) => {
    renders.set(id, (renders.get(id) ?? 0) + 1);
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <BloomProvider fonts={false} haptics={false} defaultMode="light">
        <QueryClientProvider client={queryClient}>
          <I18nextProvider i18n={appI18n}>
            <VideoPlaybackProvider>
              <VideoViewabilityProvider viewableKeys={NO_VIEWABLE_KEYS}>
                <FeedHarness handle={handle} onRender={onRender} />
              </VideoViewabilityProvider>
            </VideoPlaybackProvider>
          </I18nextProvider>
        </QueryClientProvider>
      </BloomProvider>,
    );
  });
  return { renderer, handle, renders, queryClient };
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

/**
 * Hook slots and context reads committed under the tree — the per-row work the
 * element count cannot see (a row can hold a dozen store subscriptions in one
 * component). Read off React's fibers: test-renderer instances expose them, and
 * the shape has been stable across React 18 and 19.
 */
function countHooksAndContexts(renderer: TestRenderer.ReactTestRenderer): { hooks: number; contexts: number } {
  // A test instance may hold either half of a fiber pair; the HostRoot's
  // `current` is the committed tree.
  let top = (renderer.root as unknown as { _fiber: FiberLike })._fiber;
  while (top.return) top = top.return;
  const root = top.stateNode?.current ?? top;
  let hooks = 0;
  let contexts = 0;
  const stack: FiberLike[] = [root];
  while (stack.length > 0) {
    const fiber = stack.pop()!;
    if (HOOK_FIBER_TAGS.has(fiber.tag)) {
      for (let hook = fiber.memoizedState; hook; hook = (hook.next as typeof hook) ?? null) hooks += 1;
      for (let dep = fiber.dependencies?.firstContext; dep; dep = (dep.next as typeof dep) ?? null) contexts += 1;
    }
    if (fiber.child) stack.push(fiber.child);
    if (fiber.sibling && fiber !== root) stack.push(fiber.sibling);
  }
  return { hooks, contexts };
}

function observerCount(queryClient: QueryClient): number {
  return queryClient
    .getQueryCache()
    .getAll()
    .reduce((sum, query) => sum + query.getObserversCount(), 0);
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const round = (value: number) => Math.round(value * 1000) / 1000;

function isTranslation(endpoint: string) {
  return /\/translate\b/.test(endpoint);
}

// ── Measurements ──────────────────────────────────────────────────

interface KindResult {
  mountMsPerRow: number;
  recycleMsPerRow: number;
  hostNodesPerRow: number;
  componentsPerRow: number;
  hooksPerRow: number;
  contextReadsPerRow: number;
  rendersPerMount: number;
  requestsPerRow: number;
  queryObserversPerRow: number;
}

const results: {
  meta: Record<string, unknown>;
  kinds: Partial<Record<RowKind, KindResult>>;
  isolation?: Record<string, number>;
  fling?: Record<string, number>;
} = {
  meta: {
    runtime: `node ${process.version}, jest-expo (${process.env.EXPO_OS ?? 'ios'}), React dev build`,
    runs: RUNS,
    batch: BATCH,
    note: 'ms are relative Jest timings on the recording machine, not device frame times',
  },
  kinds: {},
};

// One provider tree for the whole file: the Bloom theme engine is expensive to
// build and is app-lifetime in production, so rebuilding it per case would
// measure (and leak) something the feed never pays.
let harness!: ReturnType<typeof mountHarness>;
/** Instances the empty harness itself holds (providers), subtracted per case. */
let emptyComponents = 0;
let emptyHooks = { hooks: 0, contexts: 0 };

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await initializeI18n();
  harness = mountHarness();
  emptyComponents = harness.renderer.root.findAll(() => true, { deep: true }).length;
  emptyHooks = countHooksAndContexts(harness.renderer);
});

// A row that throws is caught by PostErrorBoundary and renders a fallback —
// which is cheap, and would make a broken harness look fast. Any crash fails.
const rowCrashes: string[] = [];
beforeAll(() => {
  const warn = console.warn;
  jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    const text = args.map(String).join(' ');
    if (text.includes('[PostErrorBoundary]')) rowCrashes.push(text);
    warn(...args);
  });
});

afterEach(() => {
  act(() => harness.handle.setPosts([]));
  harness.renders.clear();
  expect(rowCrashes.splice(0)).toEqual([]);
});

afterAll(() => {
  act(() => harness.renderer.unmount());
  const dir = join(__dirname, 'results');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, process.env.FEED_PERF_OUT ?? 'latest.json'), `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
});

describe('feed row cost', () => {
  it.each(ROW_KINDS.map((kind) => [kind]))('%s', async (kind) => {
    const { renderer, handle, renders, queryClient } = harness;
    const mountMs: number[] = [];
    const recycleMs: number[] = [];
    let hostNodes = 0;
    let components = 0;
    let hooks = 0;
    let contexts = 0;
    let rendersPerMount = 0;
    let observers = 0;
    takeRequests();
    let requests = 0;

    // Run 0 warms module init, style sheets and the i18n resources; it is
    // measured but discarded.
    for (let run = 0; run <= RUNS; run += 1) {
      const first = Array.from({ length: BATCH }, (_, i) => makeRow(kind, `${kind}-${run}-a${i}`));
      const second = Array.from({ length: BATCH }, (_, i) => makeRow(kind, `${kind}-${run}-b${i}`));

      renders.clear();
      let start = performance.now();
      // Async act: a quoted post's nested row is a lazy import, resolved on a
      // microtask; the mount is not done until it has rendered.
      await act(async () => handle.setPosts(first));
      const mounted = (performance.now() - start) / BATCH;

      if (run === 1) {
        hostNodes = countHostNodes(renderer.toJSON()) / BATCH;
        components = (renderer.root.findAll(() => true, { deep: true }).length - emptyComponents) / BATCH;
        const counted = countHooksAndContexts(renderer);
        hooks = (counted.hooks - emptyHooks.hooks) / BATCH;
        contexts = (counted.contexts - emptyHooks.contexts) / BATCH;
        rendersPerMount = [...renders.values()].reduce((a, b) => a + b, 0) / BATCH;
        observers = observerCount(queryClient) / BATCH;
      }

      start = performance.now();
      await act(async () => handle.setPosts(second));
      const recycled = (performance.now() - start) / BATCH;

      act(() => handle.setPosts([]));
      if (run > 0) {
        mountMs.push(mounted);
        recycleMs.push(recycled);
      }
      const made = takeRequests();
      if (run > 0) requests += made.length;
      expect(made.filter((r) => isTranslation(r.endpoint))).toEqual([]);
    }

    results.kinds[kind] = {
      mountMsPerRow: round(median(mountMs)),
      recycleMsPerRow: round(median(recycleMs)),
      hostNodesPerRow: round(hostNodes),
      componentsPerRow: round(components),
      hooksPerRow: round(hooks),
      contextReadsPerRow: round(contexts),
      rendersPerMount: round(rendersPerMount),
      requestsPerRow: round(requests / (RUNS * BATCH * 2)),
      queryObserversPerRow: round(observers),
    };
  });

  it('unrelated mounted rows do not re-render', () => {
    const { handle, renders } = harness;
    const posts = ROW_KINDS.map((kind, i) => makeRow(kind, `iso-${i}`));
    act(() => usePostsStore.getState().cachePosts(posts));
    act(() => handle.setPosts(posts));
    const target = posts[0].id;
    const others = () =>
      [...renders.entries()].filter(([id]) => id !== target).reduce((sum, [, n]) => sum + n, 0);

    renders.clear();
    act(() => {
      usePostsStore.setState({ isLoading: true, error: null, lastRefresh: Date.now() });
      usePostsStore.setState((s) => ({ feedUI: { ...s.feedUI, perf: { isLoading: true, error: null, lastUpdated: 1 } } }));
    });
    const unrelatedStoreWrite = [...renders.values()].reduce((a, b) => a + b, 0);

    renders.clear();
    act(() =>
      usePostsStore.getState().updatePostEverywhere(target, (prev) => ({
        ...prev,
        viewerState: { ...prev.viewerState, isLiked: true },
        engagement: { ...prev.engagement, likes: (prev.engagement.likes ?? 0) + 1 },
      })),
    );
    const otherRowsOnLike = others();
    const targetOnLike = renders.get(target) ?? 0;

    renders.clear();
    act(() => usePostsStore.getState().updatePostEverywhere(target, (prev) => ({
      ...prev,
      engagement: { ...prev.engagement, views: (prev.engagement.views ?? 0) + 10 },
    })));
    const otherRowsOnViewCount = others();

    results.isolation = {
      rowsMounted: posts.length,
      rendersOnUnrelatedStoreWrite: unrelatedStoreWrite,
      targetRendersOnLike: targetOnLike,
      otherRowRendersOnLike: otherRowsOnLike,
      otherRowRendersOnViewCount: otherRowsOnViewCount,
    };

    expect(unrelatedStoreWrite).toBe(0);
    expect(otherRowsOnLike).toBe(0);
    expect(otherRowsOnViewCount).toBe(0);
  });

  it('a deterministic fling makes no translation requests and bounded others', () => {
    const { handle, queryClient } = harness;
    const WINDOW = 12;
    const TOTAL = 200;
    const feed = Array.from({ length: TOTAL }, (_, i) => makeRow(ROW_KINDS[i % ROW_KINDS.length], `fling-${i}`));
    takeRequests();
    const start = performance.now();
    let maxObservers = 0;
    // Advance the window 3 rows at a time: rows leaving the top are recycled
    // into rows entering the bottom, as a list does during a fling.
    for (let top = 0; top + WINDOW <= TOTAL; top += 3) {
      act(() => handle.setPosts(feed.slice(top, top + WINDOW)));
      maxObservers = Math.max(maxObservers, observerCount(queryClient));
    }
    const elapsed = performance.now() - start;
    const made = takeRequests();
    const translations = made.filter((r) => isTranslation(r.endpoint)).length;

    const byEndpoint: Record<string, number> = {};
    for (const request of made) {
      const key = `${request.method} ${request.endpoint
        .replace(/^https?:\/\/[^/]+/, '')
        .replace(/\/[^/]*fling-[^/]*$/, '/:asset')
        .replace(/post-[\w-]+|[0-9a-f-]{8,}/gi, ':id')}`;
      byEndpoint[key] = (byEndpoint[key] ?? 0) + 1;
    }

    results.fling = {
      postsVisited: TOTAL,
      window: WINDOW,
      msTotal: Math.round(elapsed),
      requests: made.length,
      translationRequests: translations,
      maxQueryObservers: maxObservers,
      ...Object.fromEntries(Object.entries(byEndpoint).map(([k, v]) => [`req ${k}`, v])),
    };

    expect(translations).toBe(0);
  });

  // Last on purpose: it reads what the cases above recorded.
  it('stays within the structural budgets', () => {
    const over: string[] = [];
    for (const kind of ROW_KINDS) {
      const measured = results.kinds[kind];
      if (!measured) {
        over.push(`${kind}: not measured`);
        continue;
      }
      const nodeCeiling = budgets.hostNodesPerRow[kind];
      if (measured.hostNodesPerRow > nodeCeiling) over.push(`${kind}.hostNodesPerRow ${measured.hostNodesPerRow} > ${nodeCeiling}`);
      const hookCeiling = budgets.hooksPerRow[kind];
      if (measured.hooksPerRow > hookCeiling) over.push(`${kind}.hooksPerRow ${measured.hooksPerRow} > ${hookCeiling}`);
      const contextCeiling = budgets.contextReadsPerRow[kind];
      if (measured.contextReadsPerRow > contextCeiling) over.push(`${kind}.contextReadsPerRow ${measured.contextReadsPerRow} > ${contextCeiling}`);
      const componentCeiling = budgets.componentsPerRow[kind];
      if (measured.componentsPerRow > componentCeiling) over.push(`${kind}.componentsPerRow ${measured.componentsPerRow} > ${componentCeiling}`);
      if (measured.requestsPerRow > budgets.requestsPerRow[kind]) over.push(`${kind}.requestsPerRow ${measured.requestsPerRow} > ${budgets.requestsPerRow[kind]}`);
      if (measured.queryObserversPerRow > budgets.queryObserversPerRow[kind]) over.push(`${kind}.queryObserversPerRow ${measured.queryObserversPerRow} > ${budgets.queryObserversPerRow[kind]}`);
      if (measured.rendersPerMount > budgets.maxRendersPerMount) over.push(`${kind}.rendersPerMount ${measured.rendersPerMount} > ${budgets.maxRendersPerMount}`);
    }
    for (const [key, ceiling] of Object.entries(budgets.isolation)) {
      const measured = results.isolation?.[key];
      if (measured === undefined || measured > ceiling) over.push(`isolation.${key} ${measured} > ${ceiling}`);
    }
    const fling = results.fling;
    if (!fling) over.push('fling: not measured');
    else {
      if (fling.translationRequests > budgets.fling.translationRequests) over.push(`fling.translationRequests ${fling.translationRequests}`);
      const perPost = fling.requests / fling.postsVisited;
      if (perPost > budgets.fling.maxRequestsPerPostVisited) over.push(`fling requests per post ${perPost} > ${budgets.fling.maxRequestsPerPostVisited}`);
    }
    expect(over).toEqual([]);
  });
});
