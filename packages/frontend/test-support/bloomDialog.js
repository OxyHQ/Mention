/**
 * Jest stand-in for `@oxy.so/bloom/dialog` (mapped in package.json), one of the
 * Bloom families the Bloom language draws a screen and the shell with.
 *
 * Bloom resolves that subpath to untranspiled source that pulls in
 * reanimated/worklets, which Jest cannot load — so every route written in the
 * language (`screen()`, `layout()` from `@oxy.so/bloom-language/router`) would
 * fail to LOAD. Same reason as `bloomScreen.js` beside it. A dialog renders its children while open. A test's own
 * `jest.mock` of the module still takes precedence.
 */
const React = require('react');
const { View } = require('react-native');

const Dialog = ({ open, children }) => (open ? React.createElement(View, null, children) : null);
module.exports = {
  Dialog,
  useDialogControl: () => ({ open: () => undefined, close: () => undefined }),
};
