// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { ReactElement } from 'react';
import type { HydratedPost } from '@mention/shared-types/post';

export type SavedPost = HydratedPost;

export interface SavedPostsListProps {
  /** Viewer, search and folder identity for web layout and scroll restoration. */
  restorationKey: string;
  posts: SavedPost[];
  empty: ReactElement | null;
  footer: ReactElement | null;
  hasNextPage: boolean;
  onEndReached: () => void;
  onLongPress: (postId: string) => void;
}
