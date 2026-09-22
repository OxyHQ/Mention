/**
 * Jest stand-in for `@oxy.so/bloom/empty-state` (mapped in package.json).
 *
 * Bloom resolves that subpath to untranspiled `src/empty-state/index.ts`, which
 * Jest cannot require — so without this mapping every screen that draws an
 * empty state fails to LOAD, which is a different failure from the one the test
 * was written to catch. Same reason as `bloomIcons.js` beside it.
 *
 * It renders the copy rather than a bare host element on purpose: screens are
 * asserted on by their text ("No activity notifications", "tap the bell"), and
 * a stub that drew nothing would turn those into silent empty strings instead
 * of a missing-module error. The glyph and the actions stay as PROPS on the
 * host node, so a test that cares which glyph was chosen reads them there —
 * `components/Feed/__tests__/feedEmptyState.test.tsx` does exactly that.
 *
 * A test's own `jest.mock` of the module still takes precedence.
 */
const React = require('react');
const { Text, View } = require('react-native');

function EmptyState({ title, description, children, footer, ...rest }) {
  return React.createElement(
    View,
    { ...rest, testID: rest.testID ?? 'bloom-empty-state' },
    title ? React.createElement(Text, null, title) : null,
    description ? React.createElement(Text, null, description) : null,
    children ?? null,
    footer ?? null,
  );
}
EmptyState.displayName = 'BloomEmptyState';

module.exports = { __esModule: true, EmptyState };
