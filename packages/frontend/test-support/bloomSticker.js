// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

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

function setLottieWasmUrl() {}

module.exports = { Sticker, setLottieWasmUrl };
