// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

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
