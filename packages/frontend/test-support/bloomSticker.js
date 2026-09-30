/**
 * Jest stand-in for `@oxy.so/bloom/sticker` (mapped in package.json).
 *
 * Bloom resolves that subpath to untranspiled `src/sticker/index.ts`, which Jest
 * cannot require — the same reason as `bloomEmptyState.js` beside it. The
 * sticker's URLs and size stay as PROPS on the host node, so a test that cares
 * which sticker was drawn reads them there.
 */
const React = require('react');
const { View } = require('react-native');

function Sticker(props) {
  return React.createElement(View, { ...props, testID: props.testID ?? 'bloom-sticker' });
}

module.exports = { Sticker };
