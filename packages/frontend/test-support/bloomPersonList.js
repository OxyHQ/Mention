// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

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
