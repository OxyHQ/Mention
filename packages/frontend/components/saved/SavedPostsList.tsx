// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

// TypeScript/Jest fallback. Metro resolves `.native.tsx` or `.web.tsx`.
export { default } from './SavedPostsList.web';
export type {
  SavedPost,
  SavedPostsListProps,
} from './SavedPostsList.types';
