/**
 * Jest stand-in for `@oxy.so/bloom/typography` (mapped in package.json).
 *
 * Bloom resolves that subpath to untranspiled `src/typography/index.ts` under
 * the `react-native` condition, which Jest cannot require — so every component
 * tree that reaches a Bloom `Text` failed to LOAD unless each suite remembered
 * its own `jest.mock`. Same reason as `bloomIcons.js` and `bloomEmptyState.js`
 * beside it.
 *
 * Every export renders a host `Text` carrying the caller's props, so a test
 * still finds the copy, the accessibility props and the press handler where a
 * real render puts them. A test's own `jest.mock` of the module still takes
 * precedence.
 */
const React = require('react');
const { Text: RNText, View } = require('react-native');

function textComponent(displayName) {
  const Component = (props) => React.createElement(RNText, props);
  Component.displayName = displayName;
  return Component;
}

function Blockquote({ children, style, textStyle, testID }) {
  return React.createElement(View, { style, testID }, React.createElement(RNText, { style: textStyle }, children));
}
Blockquote.displayName = 'Blockquote';

const Text = textComponent('Text');

module.exports = {
  __esModule: true,
  Text,
  Span: Text,
  H1: textComponent('H1'),
  H2: textComponent('H2'),
  H3: textComponent('H3'),
  H4: textComponent('H4'),
  H5: textComponent('H5'),
  H6: textComponent('H6'),
  P: textComponent('P'),
  Lead: textComponent('Lead'),
  Large: textComponent('Large'),
  Small: textComponent('Small'),
  Muted: textComponent('Muted'),
  Blockquote,
  fontFamilies: {},
  TYPE_SCALE: {},
  typeScale: () => ({}),
};
