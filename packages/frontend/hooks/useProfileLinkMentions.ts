import { useEffect, useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services/ui/client';
import { publicQueryKeys } from '@/lib/viewerQueryKeys';
import { composerProfileLinks } from '@/utils/composerProfileLinks';
import type { MentionData } from '@/utils/mentions';

/** Debounce before a half-typed profile URL costs a profile lookup. */
const RESOLVE_DEBOUNCE_MS = 400;

/** How long a resolution stays fresh. Handle → account is stable. */
const RESOLVE_STALE_TIME = 5 * 60 * 1000;
const RESOLVE_GC_TIME = 30 * 60 * 1000;

/**
 * The Oxy profile shape a username lookup returns — only the fields a mention
 * needs, because the composer records an identity, not a profile.
 */
interface ResolvedProfile {
  id?: string;
  _id?: string;
  username?: string;
  name?: { displayName?: string };
}

/**
 * WHO A PASTED PROFILE LINK WILL ACTUALLY MENTION.
 *
 * The server folds a profile link into a post's real mentions only when it can
 * resolve the link to an identity it ALREADY STORES; a link it cannot resolve is
 * left exactly as the author wrote it. So this hook asks the same question the
 * same way and answers "nobody" for the same reasons — anything else would put a
 * name on screen for a post that will not carry it.
 *
 * For a profile on this instance that question is `getProfileByUsername`, which
 * is the method the server's own `resolveOxyUser` calls. It is a lookup of an
 * identity we hold, never a fetch of the pasted URL: dereferencing arbitrary
 * author-typed text would make every paste a request to a host of the author's
 * choosing.
 *
 * KNOWN GAP, stated rather than hidden: a profile link on ANOTHER host
 * (`https://mastodon.social/@alice`) is also folded server-side when we already
 * store that actor, and this hook cannot see it — the answer lives in
 * `FederatedActor` rows with no lookup-only endpoint in front of them. Resolving
 * it through `GET /federation/resolve` would be wrong twice over: that route
 * FETCHES the actor, which is exactly the fan-out the write boundary refuses, and
 * storing the actor as a side effect would make the composer CAUSE the mention it
 * is supposed to be describing. Such a link therefore gets no entry here, which
 * under-states rather than over-states. Closing the gap needs an endpoint over
 * the server's own resolver; only the query function below changes when it lands.
 *
 * A lookup that FAILS also yields no entry, and that is the right direction too:
 * the write boundary is fail-soft per link, so a lookup it could not complete
 * also leaves the link a link. Composing offline names nobody rather than
 * guessing.
 */
export function useProfileLinkMentions(
  texts: readonly string[],
  mentionIds: readonly string[],
): { linkMentions: MentionData[]; isResolving: boolean } {
  const { oxyServices } = useAuth();

  // Serialized rather than held as an array: the caller rebuilds its inputs on
  // every render, so an array identity would re-arm the debounce forever and it
  // would never fire. JSON rather than a joined string because a handle may
  // legally contain any character a URL path can encode, so no separator is safe.
  const candidatesKey = JSON.stringify(composerProfileLinks(texts, mentionIds));

  const [settledKey, setSettledKey] = useState('[]');
  useEffect(() => {
    const timeoutId = setTimeout(() => setSettledKey(candidatesKey), RESOLVE_DEBOUNCE_MS);
    return () => clearTimeout(timeoutId);
  }, [candidatesKey]);

  const handles = useMemo(() => {
    const settled = JSON.parse(settledKey) as { handle: string }[];
    // One query per DISTINCT handle: two spellings of one profile cost the server
    // two lookups, but they are one question to ask here.
    return [...new Set(settled.map((candidate) => candidate.handle))];
  }, [settledKey]);

  const results = useQueries({
    queries: handles.map((handle) => ({
      queryKey: publicQueryKeys.profileLinkMention(handle),
      queryFn: async (): Promise<MentionData | null> => {
        const profile = (await oxyServices.getProfileByUsername(handle)) as ResolvedProfile | null;
        const userId = profile?.id || profile?._id;
        const username = profile?.username;
        if (!userId || !username) return null;
        return {
          userId,
          username,
          displayName: profile.name?.displayName?.trim() || username,
        };
      },
      staleTime: RESOLVE_STALE_TIME,
      gcTime: RESOLVE_GC_TIME,
      // A miss is an ANSWER, and the SDK reports it by rejecting. Retrying would
      // spend requests re-asking a settled question, and a genuine network
      // failure resolving to no entry is the safe direction.
      retry: false,
    })),
  });

  // Deduped by id: a body can name one person through two spellings of their
  // profile URL, and the server authorizes that id once.
  const byId = new Map<string, MentionData>();
  for (const result of results) {
    const mention = result.data;
    if (mention && !byId.has(mention.userId)) byId.set(mention.userId, mention);
  }

  return {
    linkMentions: [...byId.values()],
    // Text still settling counts as resolving, so the caller can say it is
    // checking rather than assert an answer it does not have yet.
    isResolving: settledKey !== candidatesKey || results.some((result) => result.isPending),
  };
}
