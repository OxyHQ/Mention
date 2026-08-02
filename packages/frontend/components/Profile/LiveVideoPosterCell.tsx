import React from 'react';
import VideoPosterCell from '@/components/common/VideoPosterCell';
import { usePostSelector } from '@/stores/postsStore';

type PosterCellProps = React.ComponentProps<typeof VideoPosterCell>;

interface LiveVideoPosterCellProps extends Omit<PosterCellProps, 'views'> {
  /**
   * The post whose view count this cell shows — NOT necessarily the post the cell
   * navigates to. On the media grid a boost/quote with no media of its own
   * borrows the ORIGINAL's media, and the count has to describe the video being
   * shown, so the two ids diverge there.
   *
   * Optional because an embedded original can arrive without an id; the cell then
   * simply keeps its fetch-time count.
   */
  viewsPostId?: string;
  /**
   * The count as it stood when the grid's feed page was fetched.
   *
   * Load-bearing, not a nicety: a grid rendered before any of its posts entered
   * the shared cache has no store row to read, and must keep showing the number
   * it was given rather than regressing to nothing.
   */
  fallbackViews?: number | null;
}

/**
 * A {@link VideoPosterCell} whose play count is live.
 *
 * The grids read their entries out of a FEED snapshot, and a feed snapshot is
 * only invalidated by ordering/meta changes (`notifyFeedChanges`) — an engagement
 * write to a single post deliberately wakes just that post's subscribers
 * (`notifyPostChanges`, see the comment above `feedSnapshotCache` in
 * `postsStore`). So a grid cell that renders the count captured in its entry can
 * never see the view the viewer just caused; measured, a feed-snapshot consumer
 * gets zero re-renders from such a write.
 *
 * This wrapper closes that gap the same way `PostItem` already does — one
 * `usePostSelector` subscription per post — rather than by making every
 * engagement write invalidate every feed containing the post, which would put a
 * key lookup plus a full feed re-read on the hottest path in the app to serve a
 * number that moves rarely.
 *
 * It exists as a wrapper, and not as a change to `VideoPosterCell`, so that cell
 * stays a pure function of scalars: shared, memo-safe, and testable without a
 * store.
 */
const LiveVideoPosterCell = React.memo<LiveVideoPosterCellProps>(
  ({ viewsPostId, fallbackViews, ...cellProps }) => {
    const cachedPost = usePostSelector(viewsPostId);

    // The store row wins WHENEVER it exists, including when its count is null:
    // the entry was itself derived from that row, so the row is never the staler
    // of the two, and `??` here would quietly resurrect an old number for a post
    // whose count is genuinely absent.
    const views = cachedPost ? cachedPost.engagement.views : fallbackViews;

    return <VideoPosterCell {...cellProps} views={views} />;
  }
);
LiveVideoPosterCell.displayName = 'LiveVideoPosterCell';

export default LiveVideoPosterCell;
