/**
 * DEV ONLY: the Android A/B of Bloom's own language (`__perf__/lang-proof/README.md`).
 *
 * A build with `EXPO_PUBLIC_BLOOM_LANG_AB=1` carries both forms of Settings ->
 * Notifications and of PostItem's four migrated rows; the launch link picks one
 * for the life of the process:
 *
 *   adb shell am start -a android.intent.action.VIEW -d 'mention:///?bloomLangForm=ts'
 *
 * `ts` draws the TypeScript the port replaced (`__perf__/lang-proof/variants/`,
 * `__perf__/lang-proof/rows/variants/`), exactly as the app drew it; anything else
 * draws the `.bloom` modules. Without the flag every helper here is a constant
 * and the TypeScript forms are not in the bundle.
 *
 * The probes log `BLOOMAB …` lines to logcat (`ReactNativeJS`): a React
 * `<Profiler>` (timed only by the profiling renderer, `BLOOM_LANG_PROFILING=1` in
 * metro.config.js), a wall-clock mount probe, and arming of the commit and touch
 * timestamps the polyfill (`bloomLangAB.polyfill.js`) records.
 */
import {
  Profiler,
  type ProfilerOnRenderCallback,
  type ReactNode,
  useLayoutEffect,
  useRef,
} from 'react';

export const BLOOM_LANG_AB = process.env.EXPO_PUBLIC_BLOOM_LANG_AB === '1';

export type LangForm = 'ts' | 'bloom';

type ABState = { armed: boolean; form?: LangForm };
const abState = (): ABState | undefined =>
  (globalThis as { __BLOOM_LANG_AB__?: ABState }).__BLOOM_LANG_AB__;

const log = (line: string) => {
  console.log(`BLOOMAB ${line}`);
};

function readForm(): LangForm {
  if (!BLOOM_LANG_AB) return 'bloom';
  let url: string | null = null;
  try {
    url = (require('expo-linking') as typeof import('expo-linking')).getLinkingURL();
  } catch {
    url = null;
  }
  const form: LangForm = /[?&]bloomLangForm=ts\b/.test(url ?? '') ? 'ts' : 'bloom';
  const state = abState();
  if (state) state.form = form;
  log(`form=${form} url=${url ?? '-'}`);
  return form;
}

// Taps on Settings -> Notifications: the Event Timing API's entries (startTime is
// the native event's time, on performance.now()'s clock), logged while armed.
if (BLOOM_LANG_AB) {
  try {
    const PO = (globalThis as { PerformanceObserver?: typeof PerformanceObserver })
      .PerformanceObserver;
    if (PO) {
      new PO((list) => {
        if (!abState()?.armed) return;
        for (const e of list.getEntries() as PerformanceEventTiming[]) {
          log(
            `event name=${e.name} start=${e.startTime.toFixed(2)} pStart=${e.processingStart.toFixed(2)} pEnd=${e.processingEnd.toFixed(2)} duration=${e.duration.toFixed(1)}`,
          );
        }
      }).observe({
        type: 'event',
        buffered: false,
        durationThreshold: 0,
      } as PerformanceObserverInit);
      log('event-timing on');
    } else log('event-timing unavailable');
  } catch (e) {
    log(`event-timing failed ${String(e)}`);
  }
}

/** The form this process draws (read once, from the launch link). */
export const LANG_FORM: LangForm = readForm();
export const DRAW_TS = BLOOM_LANG_AB && LANG_FORM === 'ts';

const now = () => performance.now();

// Notifications: every commit of the screen, with the profiling renderer's times.
const onNotificationsRender: ProfilerOnRenderCallback = (
  id,
  phase,
  actual,
  base,
  start,
  commit,
) => {
  log(
    `render id=${id} form=${LANG_FORM} phase=${phase} actual=${actual.toFixed(3)} base=${base.toFixed(3)} start=${start.toFixed(2)} commit=${commit.toFixed(2)}`,
  );
};

/** Settings -> Notifications under the probes (identical for both forms). */
export function NotificationsProbe({ children }: { children: ReactNode }) {
  const t0 = useRef(0);
  if (t0.current === 0) t0.current = now();
  useLayoutEffect(() => {
    const t1 = now();
    const state = abState();
    if (state) state.armed = true;
    log(
      `mount-wall form=${LANG_FORM} renderToLayout=${(t1 - t0.current).toFixed(3)} t0=${t0.current.toFixed(2)}`,
    );
    requestAnimationFrame(() =>
      log(
        `mount-raf form=${LANG_FORM} t=${now().toFixed(2)} sinceT0=${(now() - t0.current).toFixed(3)}`,
      ),
    );
    return () => {
      if (state) state.armed = false;
    };
  }, []);
  return (
    <Profiler id="notifications" onRender={onNotificationsRender}>
      {children}
    </Profiler>
  );
}

// Feed posts: cumulative totals, flushed once a second while they change.
const postAgg = { n: 0, mounts: 0, updates: 0, actual: 0, base: 0, dirty: false };
let postTimer: ReturnType<typeof setInterval> | null = null;
const onPostRender: ProfilerOnRenderCallback = (_id, phase, actual, base) => {
  postAgg.n += 1;
  if (phase === 'mount') postAgg.mounts += 1;
  else postAgg.updates += 1;
  postAgg.actual += actual;
  postAgg.base += base;
  postAgg.dirty = true;
  if (postTimer == null) {
    postTimer = setInterval(() => {
      if (!postAgg.dirty) return;
      postAgg.dirty = false;
      log(
        `posts form=${LANG_FORM} t=${now().toFixed(0)} n=${postAgg.n} mounts=${postAgg.mounts} updates=${postAgg.updates} actual=${postAgg.actual.toFixed(3)} base=${postAgg.base.toFixed(3)}`,
      );
    }, 1000);
  }
};

/** A feed post under a Profiler (identical for both forms). */
export function PostProbe({ children }: { children: ReactNode }) {
  return (
    <Profiler id="post" onRender={onPostRender}>
      {children}
    </Profiler>
  );
}

type TsRows = {
  ContentWarning: typeof import('@/__perf__/lang-proof/rows/variants/ContentWarning').default;
  PostCommunityRow: typeof import('@/__perf__/lang-proof/rows/variants/PostCommunityRow').default;
  PostCorrectionNotice: typeof import('@/__perf__/lang-proof/rows/variants/PostCorrectionNotice').default;
  PostLaneChip: typeof import('@/__perf__/lang-proof/rows/variants/PostLaneChip').default;
  Notifications: typeof import('@/__perf__/lang-proof/variants/original').default;
};

/** The TypeScript forms, in the bundle only with the flag. */
export const TS_FORMS: TsRows | null = BLOOM_LANG_AB
  ? {
      ContentWarning: require('@/__perf__/lang-proof/rows/variants/ContentWarning').default,
      PostCommunityRow: require('@/__perf__/lang-proof/rows/variants/PostCommunityRow').default,
      PostCorrectionNotice: require('@/__perf__/lang-proof/rows/variants/PostCorrectionNotice')
        .default,
      PostLaneChip: require('@/__perf__/lang-proof/rows/variants/PostLaneChip').default,
      Notifications: require('@/__perf__/lang-proof/variants/original').default,
    }
  : null;

/**
 * `EXPO_PUBLIC_BLOOM_LANG_AB_ROWS=1`: a public feed carries none of the four rows
 * (0 in 1,017 explore/trending posts, 2026-11-26), so the A/B gives each feed post
 * one, picked by its id: a content warning, a community, a correction trail or a
 * lane. Both forms read the same decorated post; nothing else changes.
 */
export const AB_ROWS = BLOOM_LANG_AB && process.env.EXPO_PUBLIC_BLOOM_LANG_AB_ROWS === '1';
const decorated = new WeakMap<object, object>();
export function abDecoratePost<T>(post: T): T {
  if (!AB_ROWS || post == null || typeof post !== 'object') return post;
  const cached = decorated.get(post as object);
  if (cached) return cached as T;
  const source = post as Record<string, unknown> & {
    id?: unknown;
    metadata?: Record<string, unknown>;
  };
  const id = String(source.id ?? '');
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  const next: Record<string, unknown> = { ...source };
  switch (Math.abs(hash) % 4) {
    case 0:
      next.metadata = { ...source.metadata, spoilerText: 'Spoilers for the season finale' };
      break;
    case 1:
      next.community = {
        id: 'bloom-lang-ab-community',
        username: 'bloomlang',
        instance: 'lemmy.world',
        isFederated: true,
        type: 'federated',
        name: 'Bloom language',
      };
      break;
    case 2:
      next.metadata = {
        ...source.metadata,
        corrections: { count: 2, lastCorrectedAt: '2026-11-20T10:00:00.000Z' },
      };
      break;
    default:
      next.lane = { id: 'bloom-lang-ab-lane', name: 'Design notes', displayMode: 'mixed' };
  }
  decorated.set(post as object, next);
  return next as T;
}
