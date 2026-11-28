// Settings tests retain labels and controls while Bloom tests own row geometry.
const React = require('react');
const { Text, View } = require('react-native');
exports.GroupedSection = function GroupedSection({ children, title, footer }) {
  return React.createElement(
    View,
    null,
    title && React.createElement(Text, null, title),
    children,
    footer,
  );
};
exports.GroupedSectionItem = function GroupedSectionItem({ title, description, rightElement }) {
  return React.createElement(
    View,
    null,
    React.createElement(Text, null, title),
    description && React.createElement(Text, null, description),
    rightElement,
  );
};
