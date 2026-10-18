// Bloom owns layout measurement; Mention screen tests inspect its content.
const React = require('react');
const { View } = require('react-native');
module.exports = {
  ResponsiveGrid: ({ children, ...props }) => React.createElement(View, props, children),
};
