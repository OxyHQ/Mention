// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

// Base module for ESLint / tsc import resolution.
// At build time, bundlers resolve socketBfcache.native.ts or socketBfcache.web.ts instead.
export { registerSocketBfcacheRelease } from './socketBfcache.web';
