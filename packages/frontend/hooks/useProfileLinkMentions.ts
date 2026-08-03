import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { publicQueryKeys } from '@/lib/viewerQueryKeys';
import { composerProfileLinks } from '@/utils/composerProfileLinks';
import { authenticatedClient } from '@/utils/api';
import type { ProfileLinkMentionsResponse } from '@mention/shared-types/mentions';
import type { MentionData } from '@/utils/mentions';

/** Debounce before a half-typed profile URL costs a profile lookup. */
const RESOLVE_DEBOUNCE_MS = 400;

/** How long a resolution stays fresh. URL → account is stable. */
const RESOLVE_STALE_TIME = 5 * 60 * 1000;
const RESOLVE_GC_TIME = 30 * 60 * 1000;

/**
 * WHO A PASTED PROFILE LINK WILL ACTUALLY MENTION.
 *
 * The server folds a profile link into a post's real mentions only when it can
 * resolve the link to an identity it ALREADY STORES; a link it cannot resolve is
 * left exactly as the author wrote it. So this hook asks the same question the
 * same way and answers "nobody" for the same reasons — anything else would put a
 * name on screen for a post that will not carry it.
 *
 * It asks the SERVER, through `POST /mentions/profile-links`, because the server
 * is the only side that can answer for a link on another host: a
 * `https://mastodon.social/@alice` is folded into a post's mentions whenever we
 * already store that actor, and that answer lives in `FederatedActor` rows. The
 * endpoint is lookup-only and takes the URL rather than a handle — it never
 * dereferences the pasted address, so asking cannot CREATE the identity it is
 * being asked about, and there is no second place for a URL to be read into a
 * handle differently than the write boundary reads it.
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
  // Serialized rather than held as an array: the caller rebuilds its inputs on
  // every render, so an array identity would re-arm the debounce forever and the
  // row would never appear at all — verified, not theorised. JSON rather than a
  // joined string because a URL may legally contain any separator you might pick.
  const candidatesKey = JSON.stringify(composerProfileLinks(texts, mentionIds));

  const [settledKey, setSettledKey] = useState('[]');
  useEffect(() => {
    const timeoutId = setTimeout(() => setSettledKey(candidatesKey), RESOLVE_DEBOUNCE_MS);
    return () => clearTimeout(timeoutId);
  }, [candidatesKey]);

  // `composerProfileLinks` already yields DISTINCT urls, in reading order, so the
  // parse is the whole step. The URLs are asked about as-is: the server spends a
  // slot per URL, so two spellings of one profile are two questions there and two
  // here, and the duplicate collapses on the identity in the answer.
  const urls = useMemo(() => JSON.parse(settledKey) as string[], [settledKey]);

  const { data, isFetching } = useQuery({
    queryKey: publicQueryKeys.profileLinkMentions(urls),
    enabled: urls.length > 0,
    queryFn: async (): Promise<MentionData[]> => {
      const response = await authenticatedClient.post<ProfileLinkMentionsResponse>(
        '/mentions/profile-links',
        { urls },
      );
      return response.data.links.flatMap((link) =>
        link.mention
          ? [{
              userId: link.mention.userId,
              username: link.mention.handle,
              displayName: link.mention.displayName,
            }]
          : [],
      );
    },
    staleTime: RESOLVE_STALE_TIME,
    gcTime: RESOLVE_GC_TIME,
    // A miss is an ANSWER — the endpoint reports it as `mention: null` per URL
    // rather than by failing — so a rejection here is a transport problem, and
    // re-asking a settled question would only spend requests. Naming nobody is
    // the safe direction either way.
    retry: false,
  });

  // Deduped by id: a body can name one person through two spellings of their
  // profile URL, and the server authorizes that id once.
  const byId = new Map<string, MentionData>();
  for (const mention of data ?? []) {
    if (!byId.has(mention.userId)) byId.set(mention.userId, mention);
  }

  return {
    linkMentions: [...byId.values()],
    // Text still settling counts as resolving, so the caller can say it is
    // checking rather than assert an answer it does not have yet. `isFetching`
    // rather than `isPending`, which stays true for as long as the query is
    // disabled — a body with no candidate link is not "still checking".
    isResolving: settledKey !== candidatesKey || isFetching,
  };
}
