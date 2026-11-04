import type { DatabaseOrTransaction } from '../db/postgres';
import { callerOxyUser, createScopedOxyClient } from '../utils/oxyHelpers';
import { safetyRequesterFor, type RequestSafetyContext } from '../utils/safetyRequester';
import { postHydrationService } from './PostHydrationService';

/**
 * May the person behind this request act on the post with this id?
 *
 * Every action that names a post by id — liking it, saving it, counting a view of
 * it, replying under it, listing its replies or quotes, reading its reply and
 * quote controls — asks THIS question first, and it is the read gate itself
 * (`PostHydrationService.canViewerReadPostId`): drafts and scheduled posts,
 * private and direct posts and their recipients, followers-only posts, blocks
 * and restrictions, private profiles and central safety decisions, all in one
 * place. An action that skipped it turned the post id into an oracle: a 404 for
 * a missing post against a 200 for a hidden one, the hidden post's counters, a
 * notification to the author of a post the actor was never shown.
 *
 * Callers answer `false` with EXACTLY the response they give a post that does not
 * exist, so the two cannot be told apart.
 */
export function canRequestReadPost(
  req: RequestSafetyContext,
  postId: string,
  db?: DatabaseOrTransaction,
): Promise<boolean> {
  return postHydrationService.canViewerReadPostId(
    postId,
    req.user?.id ?? '',
    {
      safetyRequester: safetyRequesterFor(req),
      oxyClient: createScopedOxyClient(req),
      operatedAccountReader: callerOxyUser(req),
    },
    db,
  );
}
