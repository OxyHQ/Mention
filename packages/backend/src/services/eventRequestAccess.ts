import type { OxyAuthRequest } from '@oxy.so/core/server';
import { loadPostRecord } from '../db/posts/postRepository';
import { createScopedOxyClient, createUserScopedOxyServices } from '../utils/oxyHelpers';
import { safetyRequesterFor } from '../utils/safetyRequester';
import { postHydrationService } from './PostHydrationService';
import { membershipAuthorizesActingFor, resolveAccountKind } from './publishAsAccount';
import { EventError, type EventAccess } from './EventAttendanceService';

export function eventAccessFor(req: OxyAuthRequest, postId: string): EventAccess {
  let expected: Awaited<ReturnType<typeof loadPostRecord>> | undefined;
  let kind: Awaited<ReturnType<typeof resolveAccountKind>>;
  const viewerId = req.user?.id ?? '';
  const reader = createUserScopedOxyServices(req);
  // Identity summaries may borrow a DB connection; resolve kind before opening
  // the transaction. The shared post ACL and live Oxy membership are checked
  // after the parent lock, with local ACL reads on that transaction connection.
  const canManage = async (authorId: string | null | undefined) => {
    if (!viewerId || !authorId) return false;
    if (viewerId === authorId) return true;
    if (!reader || !kind || kind === 'personal') return false;
    try {
      const members = await reader.accounts.members.list(authorId);
      return membershipAuthorizesActingFor(
        kind,
        members.find((member) => member.memberUserId === viewerId),
      );
    } catch {
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
