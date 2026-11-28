// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

// Base module for tsc / ESLint resolution.
// At bundle time, Metro resolves Feed.native.tsx (FlashList) on native and
// Feed.web.tsx (window virtualizer + document scroll) on web instead. The two
// platform files differ ONLY in how they virtualize: data, rows, pagination,
// states and telemetry come from ./useFeedCore, rows render via ./feedRows.
export { default } from './Feed.web';
