// Base module for tsc / ESLint resolution.
// At bundle time, Metro resolves Feed.native.tsx (FlashList) on native and
// Feed.web.tsx (window virtualizer + document scroll) on web instead. The two
// platform files differ ONLY in how they virtualize: data, rows, pagination,
// states and telemetry come from ./useFeedCore, rows render via ./feedRows.
export { default } from './Feed.web';
