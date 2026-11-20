/**
 * Jest stand-in for `@oxy.so/bloom/app-shell` (mapped in package.json), one of the
 * Bloom families the Bloom language draws a screen and the shell with.
 *
 * Bloom resolves that subpath to untranspiled source that pulls in
 * reanimated/worklets, which Jest cannot load — so every route written in the
 * language (`screen()`, `layout()` from `@oxy.so/bloom-language/router`) would
 * fail to LOAD. Same reason as `bloomScreen.js` beside it. The shell renders its children. A test's own
 * `jest.mock` of the module still takes precedence.
 */
const React = require('react');
const { View } = require('react-native');

module.exports = {
  AppShell: ({ children }) => React.createElement(View, null, children),
};
