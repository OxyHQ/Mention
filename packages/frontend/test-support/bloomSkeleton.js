// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

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
