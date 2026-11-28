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
