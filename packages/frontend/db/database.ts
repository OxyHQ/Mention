// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

// TypeScript fallback. Metro resolves database.native.ts or database.web.ts
// first for platform builds; using the web contract here keeps editor and
// non-Metro tooling free of expo-sqlite.
export * from './database.web';
