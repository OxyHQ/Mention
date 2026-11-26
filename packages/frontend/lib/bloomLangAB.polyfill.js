/**
 * DEV ONLY: run before every module in an `EXPO_PUBLIC_BLOOM_LANG_AB=1` native
 * build (metro.config.js adds it to the polyfills); see `bloomLangAB.tsx`.
 *
 * - A minimal `__REACT_DEVTOOLS_GLOBAL_HOOK__`, which both the production and the
 *   profiling renderer call on every commit: the commit's time.
 *
 * (Tap times come from the Event Timing API in `bloomLangAB.tsx`: replacing
 * `nativeFabricUIManager` with a wrapper crashes UIManagerBinding::getBinding,
 * which needs the host object itself.)
 *
 * Logged only while Settings -> Notifications is mounted (`armed`), on
 * `performance.now()`, which on React Native 0.88 is steady_clock, the
 * CLOCK_MONOTONIC that `dumpsys gfxinfo … framestats` reports in nanoseconds.
 */
((global) => {
  const state = { armed: false, form: undefined, commits: 0 };
  global.__BLOOM_LANG_AB__ = state;
  const now = () => (global.performance?.now ? global.performance.now() : Date.now());
  const log = (line) => {
    try {
      if (global.console) global.console.log(`BLOOMAB ${line}`);
    } catch (_e) {}
  };

  global.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject: () => 1,
    onCommitFiberRoot: () => {
      state.commits += 1;
      if (state.armed) log(`commit t=${now().toFixed(2)} n=${state.commits}`);
    },
    onCommitFiberUnmount: () => {},
    onPostCommitFiberRoot: () => {},
    checkDCE: () => {},
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
