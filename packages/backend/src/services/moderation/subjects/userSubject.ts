import { config } from '../../../config';
import { getRuntimeOxyClient } from '../../../runtime/oxyClient';
import type { ModerationSubjectProvider, ModerationSubjectSnapshot } from './types';

/**
 * A reported account, as universal material (§5.3 `profile`).
 *
 * Oxy owns identity, so the material comes from Oxy and is passed through
 * unchanged. In particular `name.displayName` is read directly and never
 * recomposed from `first`/`last`/`full` or from the username: what a jury judges
 * has to be what the account actually shows, and a name this code assembled would
 * be evidence Mention invented.
 *
 * A profile with no display name is normal (a federated or unresolved actor
 * routinely has none) and every field of §5.3's `profile` resource is optional for
 * exactly that reason, so nothing here substitutes a handle for a missing name.
 * The handle travels separately, as a claim.
 */

/** §5.3 `profile.claims`: bounded, flat, scalar. */
const MAX_CLAIM_LENGTH = 200;

function claim(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, MAX_CLAIM_LENGTH) : undefined;
}

export function createUserSubjectProvider(): ModerationSubjectProvider {
  return {
    reportedType: 'user',
    subjectType: 'identity.profile',

    async snapshot(reportedId: string): Promise<ModerationSubjectSnapshot | null> {
      /**
       * `cache: false`: a jury must review the profile as it is now, and the SDK's
       * five-minute GET cache would otherwise let a stale display name or bio be
       * the thing that was reviewed. A moderation snapshot is a
       * consistency-critical read.
       */
      const user = await getRuntimeOxyClient().getUserById(reportedId, { cache: false });
      if (!user) return null;

      const displayName = claim(user.name?.displayName);
      const bio = claim(user.description ?? user.bio);
      const username = claim(user.username);

      /**
       * Claims, not evidence. A username and a website are what the account
       * asserts about itself; they matter for an impersonation allegation and are
       * exactly the fields §5.3 means by `claims`.
       */
      const claims: Record<string, string> = {};
      if (username !== undefined) claims.username = username;
      const website = claim(user.website);
      if (website !== undefined) claims.website = website;

      return {
        subject: {
          externalId: reportedId,
          type: 'identity.profile',
          /**
           * Omitted when the handle did not resolve. `/@<oxyUserId>` is not a
           * Mention profile URL — emitting a raw id where a handle belongs is the
           * ghost-handle bug, and a permalink is optional precisely so nobody has
           * to invent one.
           */
          ...(username === undefined
            ? {}
            : { permalink: `${config.web.origin}/@${username}` }),
          author: { oxyUserId: reportedId },
        },
        content: {
          type: 'profile',
          data: {
            ...(displayName === undefined ? {} : { displayName }),
            ...(bio === undefined ? {} : { bio }),
            ...(Object.keys(claims).length > 0 ? { claims } : {}),
          },
        },
      };
    },
  };
}
