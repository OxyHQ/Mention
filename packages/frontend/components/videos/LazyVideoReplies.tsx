import React, { lazy, Suspense } from 'react';
import { Loading } from '@oxy.so/bloom/loading';
import type { VideoRepliesProps } from './VideoReplies';

// The one async boundary for the replies panel. `RightBar` renders on every
// desktop route, so a static import would put the panel's FlashList feed and
// reply composer in the initial web bundle for readers who never open a video.
// Both callers go through this module so Metro keeps the panel in one chunk:
// two separate `import()` sites would share it and promote it to `__common`.
const VideoReplies = lazy(() =>
  import('./VideoReplies').then((module) => ({ default: module.VideoReplies })),
);

export function LazyVideoReplies(props: VideoRepliesProps) {
  return (
    <Suspense fallback={<Loading />}>
      <VideoReplies {...props} />
    </Suspense>
  );
}
