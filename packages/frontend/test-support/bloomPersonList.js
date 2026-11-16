// Render the data/action slots at the shared List boundary; geometry belongs to Bloom.
const React = require('react');
const { View, TouchableOpacity } = require('react-native');

exports.ListItem = function ListItem({ leading, content, trailing, onPress }) {
  const opening = onPress
    ? React.createElement(TouchableOpacity, {
        onPress,
        accessibilityRole: 'button',
        testID: 'profile-row-open',
      })
    : null;
  return React.createElement(View, null, opening, leading, content, trailing);
};
