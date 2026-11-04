import { accessErrorStatus, OxyAccessError, type OxyAuthRequest } from '@oxy.so/core/server';
import { loadPostRecord } from '../db/posts/postRepository';
import { callerAccountAccess, callerOxyUser, createScopedOxyClient } from '../utils/oxyHelpers';
import { safetyRequesterFor } from '../utils/safetyRequester';
import { postHydrationService } from './PostHydrationService';
import { accessAuthorizesActingFor, resolveAccountKind } from './publishAsAccount';
import { EventError, type EventAccess } from './EventAttendanceService';

export function eventAccessFor(req: OxyAuthRequest, postId: string): EventAccess {
  let expected: Awaited<ReturnType<typeof loadPostRecord>> | undefined;
  let kind: Awaited<ReturnType<typeof resolveAccountKind>>;
  const viewerId = req.user?.id ?? '';
  const reader = callerOxyUser(req);
  // Identity summaries may borrow a DB connection; resolve kind before opening
  // the transaction. The shared post ACL and live Oxy membership are checked
  // after the parent lock, with local ACL reads on that transaction connection.
  const canManage = async (authorId: string | null | undefined) => {
    if (!viewerId || !authorId) return false;
    if (viewerId === authorId) return true;
    // A NEW reader per check: `callerAccountAccess` memoizes per request, and
    // the check after the parent lock must be a fresh answer, not the first one.
    const accountAccess = callerAccountAccess(req);
    if (!accountAccess || !kind || kind === 'personal') return false;
    try {
      return accessAuthorizesActingFor(kind, await accountAccess(authorId));
    } catch (error) {
      // Oxy's definitive "no" (403/404) is an answer; a gone session asks the
      // person to sign in again; anything else is an outage, never a "no".
      const status = error instanceof OxyAccessError ? accessErrorStatus(error) : 503;
      if (status === 403 || status === 404) return false;
      if (status === 401) {
        throw new EventError(401, 'unauthorized', 'Sign in again to manage this event');
      }
      throw new EventError(
        503,
        'service_unavailable',
        'Account permissions are temporarily unavailable',
      );
    }
  };
  const access: EventAccess = {
    viewerId,
    prepare: async () => {
      expected = await loadPostRecord(postId);
      kind = await resolveAccountKind(expected?.oxyUserId);
    },
    assertCurrent: async (row) => {
      if (
        !expected ||
        row.updatedAt.getTime() !== expected.updatedAt.getTime() ||
        row.visibility !== expected.visibility ||
        row.oxyUserId !== expected.oxyUserId
      ) {
        throw new EventError(
          409,
          'conflict',
          'The post changed while permissions were checked. Refresh and try again.',
        );
      }
    },
    read: async (tx) =>
      postHydrationService.canViewerReadPostId(
        postId,
        viewerId,
        {
          oxyClient: createScopedOxyClient(req),
          operatedAccountReader: reader,
          safetyRequester: safetyRequesterFor(req),
        },
        tx,
      ),
    manage: async (row) => {
      if (row) return canManage(row.oxyUserId); // fresh Oxy authority AFTER lock
      const post = await loadPostRecord(postId);
      kind = await resolveAccountKind(post?.oxyUserId);
      return canManage(post?.oxyUserId);
    },
  };
  return access;
}
