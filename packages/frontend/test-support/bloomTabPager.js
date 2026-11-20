/**
 * Jest stand-in for `@oxy.so/bloom/tab-pager` (mapped in package.json), one of the
 * Bloom families the Bloom language draws a screen and the shell with.
 *
 * Bloom resolves that subpath to untranspiled source that pulls in
 * reanimated/worklets, which Jest cannot load — so every route written in the
 * language (`screen()`, `layout()` from `@oxy.so/bloom-language/router`) would
 * fail to LOAD. Same reason as `bloomScreen.js` beside it. The pager answers as one with no pages. A test's own
 * `jest.mock` of the module still takes precedence.
 */
const React = require('react');
const { View } = require('react-native');

const named = (name) => {
  const Component = ({ children }) => React.createElement(View, { testID: name }, children);
  Component.displayName = name;
  return Component;
};

const pager = {
  pages: [],
  activePage: null,
  progress: { value: 0 },
  chromeProgress: { value: 0 },
  selectTab: () => {},
  leaveTab: () => {},
  selectDestination: () => {},
};
module.exports = { useTabPager: () => pager, TabPagerBottomBar: named('TabPagerBottomBar') };
