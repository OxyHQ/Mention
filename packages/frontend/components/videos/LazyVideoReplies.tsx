// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { FeedSkeleton } from '@/components/loading/ContentSkeleton';
import { lazy, Suspense } from 'react';
import type { VideoRepliesProps } from './VideoReplies';

// The supporting-panel host is the sole lazy boundary for replies and their composer.
const VideoReplies = lazy(() =>
  import('./VideoReplies').then((module) => ({ default: module.VideoReplies })),
);

export function LazyVideoReplies(props: VideoRepliesProps) {
  return (
    <Suspense fallback={<FeedSkeleton />}>
      <VideoReplies {...props} />
    </Suspense>
  );
}
