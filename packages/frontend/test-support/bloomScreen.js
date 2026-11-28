/**
 * Jest stand-in for `@oxy.so/bloom/screen` (mapped in package.json).
 *
 * Bloom resolves that subpath to untranspiled source whose scroll binding pulls
 * in reanimated/worklets, which Jest cannot load — so every page that renders a
 * `Screen`, or merely asks it for Back, would fail to LOAD. Same reason as
 * `bloomDropdownMenu.js` beside it.
 *
 * `Screen` renders its header, content and footer in order, so a page is still
 * asserted on by what it shows. The hooks answer as a Screen with nothing to
 * scroll, no Back and no reselect handler would. A test's own `jest.mock` of the
 * module still takes precedence.
 */
const React = require('react');
const { ScrollView, View } = require('react-native');

const shared = { value: 0 };
const binding = {
  onScroll: undefined,
  scrollerId: 'screen',
  contentInsets: { top: 0, bottom: 0 },
  scrollY: shared,
  collapseProgress: shared,
};

const Screen = ({ header, bottomBar, primaryAction, children, testID }) =>
  React.createElement(View, { testID }, header, children, bottomBar, primaryAction);
const ScreenScrollView = React.forwardRef(function ScreenScrollView({ children, ...props }, ref) {
  return React.createElement(ScrollView, { ...props, ref }, children);
});
const ScreenPager = ({ children }) => React.createElement(View, null, children);
const ScreenReselectScope = ({ children }) => React.createElement(React.Fragment, null, children);
const noop = () => {};

module.exports = {
  Screen,
  ScreenScrollView,
  ScreenPager,
  ScreenReselectScope,
  useScreen: () => ({ active: true, ...binding, collapseTarget: shared, activeScrollerId: shared }),
  useScreenScroll: () => binding,
  useScreenWindowScroll: () => binding,
  useScreenViewport: () => null,
  useScreenBack: () => undefined,
  useScreenVisible: () => true,
  useScreenReselect: () => noop,
  useScreenReselectHandler: noop,
  useFrontScroller: () => () => null,
};
