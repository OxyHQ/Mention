/**
 * Jest stand-in for `@oxy.so/bloom/dropdown-menu` (mapped in package.json).
 *
 * Bloom resolves that subpath to untranspiled source whose overlay stack pulls
 * in reanimated/worklets, which Jest cannot load — so every screen that draws
 * a ⋯ menu would fail to LOAD. Same reason as `bloomEmptyState.js` beside it.
 *
 * The trigger renders its child; the content and rows render their children
 * and their title, so a test that opens a menu can read the rows. A test's own
 * `jest.mock` of the module still takes precedence.
 */
const React = require('react');
const { Text, View } = require('react-native');

const passthrough = ({ children }) => React.createElement(React.Fragment, null, children);

const DropdownMenuItem = ({ children, onPress }) =>
  React.createElement(Text, { onPress, accessibilityRole: 'menuitem' }, children);

module.exports = {
  DropdownMenu: passthrough,
  DropdownMenuTrigger: passthrough,
  DropdownMenuContent: ({ children }) => React.createElement(View, null, children),
  DropdownMenuGroup: passthrough,
  DropdownMenuSeparator: () => null,
  DropdownMenuLabel: passthrough,
  DropdownMenuItem,
  DropdownMenuCheckboxItem: DropdownMenuItem,
  DropdownMenuRadioGroup: passthrough,
  DropdownMenuRadioItem: DropdownMenuItem,
};
