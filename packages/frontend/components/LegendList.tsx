// Base module for tsc / ESLint resolution.
// At bundle time, Metro resolves LegendList.native.tsx (@legendapp/list + the
// LayoutScroll wheel bridge) on native and LegendList.web.tsx (window virtualizer
// under the document scroller, no wheel bridge) on web instead.
export { default } from './LegendList.web';
