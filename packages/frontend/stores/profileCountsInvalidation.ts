import type { QueryClient } from '@tanstack/react-query';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

/**
 * The single authority for "a write changed how many posts, boosts or replies
 * an account has".
 *
 * A profile's counters ride its appearance payload (`useProfileData` →
 * `viewerQueryKeys.appearanceForUser`), cached behind a five-minute staleTime.
 * The new post itself reaches the profile list at once through the posts store,
 * so without this the profile read "0 Posts" above the post it had just listed
 * (#1140).
 *
 * The acting viewer's own counters always move, so their own entry is always
 * dropped. `authorId` names the account the write was published AS when that
 * can differ from the viewer: a channel the viewer posts for, or the author of
 * a post the viewer deleted. Call it only once the server accepted the write.
 *
 * The client is a parameter, not an import: the post menu is handed its client
 * by the controller that binds it, and this module stays free of the app
 * singleton so importing it constructs nothing.
 */
export function invalidateProfileCounts(
  client: Pick<QueryClient, 'invalidateQueries'>,
  authorId?: string | null,
): void {
  void client.invalidateQueries({
    predicate: (query) =>
      viewerQueryKeys.isOwnAppearance(query.queryKey) ||
      (authorId ? viewerQueryKeys.isAppearanceForUser(query.queryKey, authorId) : false),
  });
}
