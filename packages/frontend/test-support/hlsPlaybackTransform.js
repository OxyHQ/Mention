// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

// Keep Expo's normal transform while executing selected lazy imports in Jest's
// VM. Production still uses Metro's asynchronous chunks.
const [babelJest, options] = require('jest-expo/jest-preset').transform['\\.[jt]sx?$'];
module.exports = require(babelJest).createTransformer({
  ...options,
  plugins: [require.resolve('./perfDynamicImport')],
});
