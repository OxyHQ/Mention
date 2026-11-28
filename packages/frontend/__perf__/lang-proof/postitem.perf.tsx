import { Profiler, useState, type ProfilerOnRenderCallback, type ReactElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { BloomProvider } from '@oxy.so/bloom/provider';
import { VideoPlaybackProvider, VideoViewabilityProvider } from '@oxy.so/bloom/video-playback';

import { appI18n, initializeI18n } from '@/lib/i18n';
import { usePostsStore } from '@/stores/postsStore';
import { makeRow } from '@/components/Feed/__perf__/fixtures';
import { POST_FORMS, POST_KINDS, drawPost, type PostForm } from './postitem/posts';

/**
 * DEV ONLY. PostItem's timing proof (`README.md`, "PostItem"): the TypeScript row
 * (`postitem/variants/PostItem.tsx`) against `PostItem.bloom`, under the feed harness's
 * providers and stand-ins (`test-support/perfSetup.ts`). Per fixture kind: the mount of one
 * post and the update of the same row to another post (a recycle, as FlashList does), wall
 * time and Profiler actualDuration, median and p95 over RUNS after WARMUP, the two forms
 * interleaved in a rotating order. The structural cost is the feed harness's
 * (`components/Feed/__perf__`, run in both forms). Run with
 * `bun run test:perf __perf__/lang-proof/postitem`; results in `results/postitem.json`.
 */

const RUNS = Number(process.env.PROOF_PERF_RUNS ?? 200);
const WARMUP = Number(process.env.PROOF_PERF_WARMUP ?? 30);
const NO_VIEWABLE_KEYS: ReadonlySet<string> = new Set();

type Shown = { form: PostForm; post: ReturnType<typeof makeRow> } | null;
const handle: { show: (shown: Shown) => void } = { show: () => undefined };
let profiled = 0;
const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  profiled += actualDuration;
};

function Host(): ReactElement | null {
  const [shown, setShown] = useState<Shown>(null);
  handle.show = setShown;
  return shown ? (
    <Profiler key={shown.form} id={shown.form} onRender={onRender}>
      {drawPost(shown.form, shown.post)}
    </Profiler>
  ) : null;
}

function mountHost(): TestRenderer.ReactTestRenderer {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <BloomProvider fonts={false} haptics={false} defaultMode="light">
        <QueryClientProvider client={queryClient}>
          <I18nextProvider i18n={appI18n}>
            <VideoPlaybackProvider>
              <VideoViewabilityProvider viewableKeys={NO_VIEWABLE_KEYS}>
                <Host />
              </VideoViewabilityProvider>
            </VideoPlaybackProvider>
          </I18nextProvider>
        </QueryClientProvider>
      </BloomProvider>,
    );
  });
  return renderer;
}

const quantile = (values: number[], q: number) => {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const ms = (value: number) => Math.round(value * 1000) / 1000;
const summary = (values: number[]) => ({
  median: ms(quantile(values, 0.5)),
  p95: ms(quantile(values, 0.95)),
});

const results: { meta: Record<string, unknown>; timing: Record<string, unknown> } = {
  meta: {
    runtime: `node ${process.version}, jest-expo, React development build`,
    machine: `${cpus()[0]?.model ?? 'unknown cpu'} x${cpus().length}`,
    compiler: require('@oxy.so/bloom-language-compiler/package.json').version,
    runs: RUNS,
    warmup: WARMUP,
    note: 'forms interleaved per run in a rotating order; ms are relative Jest timings',
  },
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
    join(dir, process.env.PROOF_OUT ?? 'postitem.json'),
    `${JSON.stringify(results, null, 2)}\n`,
  );
});

describe('PostItem, timed together', () => {
  it.each(POST_KINDS.map((kind) => [kind]))('times mount and recycle: %s', (kind) => {
    const first = makeRow(kind, `timed-${kind}-a`);
    const second = makeRow(kind, `timed-${kind}-b`);
    act(() => usePostsStore.getState().cachePosts([first, second]));
    const renderer = mountHost();
    const series = () => Object.fromEntries(POST_FORMS.map((f) => [f, [] as number[]]));
    const mountWall = series();
    const mountProfiled = series();
    const updateWall = series();
    const updateProfiled = series();
    for (let run = 0; run < WARMUP + RUNS; run += 1) {
      const order = run % 2 === 0 ? POST_FORMS : [...POST_FORMS].reverse();
      for (const form of order) {
        act(() => handle.show(null));
        profiled = 0;
        let start = performance.now();
        act(() => handle.show({ form, post: first }));
        const mounted = performance.now() - start;
        const mountedProfiled = profiled;
        profiled = 0;
        start = performance.now();
        act(() => handle.show({ form, post: second }));
        const updated = performance.now() - start;
        if (run >= WARMUP) {
          mountWall[form].push(mounted);
          mountProfiled[form].push(mountedProfiled);
          updateWall[form].push(updated);
          updateProfiled[form].push(profiled);
        }
      }
    }
    results.timing[kind] = Object.fromEntries(
      POST_FORMS.map((form) => [
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
    expect(mountWall.bloom).toHaveLength(RUNS);
  });
});
