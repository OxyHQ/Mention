// Screen tests exercise loading decisions and content anatomy. Bloom's own
// tests cover its theme, shared shimmer driver and accessibility semantics.
const React = require('react');
const { View } = require('react-native');
const shape = (name) => {
  const Component = (props) => React.createElement(View, props);
  Component.displayName = `Skeleton.${name}`;
  return Component;
};
module.exports = Object.fromEntries(
  ['Region', 'Text', 'Circle', 'Pill', 'Box', 'Row', 'Col'].map((name) => [name, shape(name)]),
);
