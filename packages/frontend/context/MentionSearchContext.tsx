import { createContext, useContext, useMemo } from 'react';
import { useAuth } from '@oxy.so/services/ui/client';
import {
  createMentionSearchCache,
  toMentionUsers,
  type MentionSearchCache,
} from '@/utils/mentionSearch';

/**
 * One mention search cache per composer session, shared by every
 * `MentionTextInput` in it (main box, thread items, language renditions) and by
 * the composer's submit, which resolves a trailing typed handle from it.
 */
export const MentionSearchContext = createContext<MentionSearchCache | null>(null);

/** Build the session cache over Oxy's profile search. */
export function useCreateMentionSearchCache(): MentionSearchCache {
  const { oxyServices, user } = useAuth();
  const viewerId = user?.id;
  // Keyed on the viewer too: what a search returns depends on who asks
  // (blocks), and an account switch must not answer from the last one's cache.
  return useMemo(
    () => createMentionSearchCache(async (query) => {
      const { data } = await oxyServices.users.search(query, { limit: 10 });
      return toMentionUsers(data);
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [oxyServices, viewerId],
  );
}

/** The session's cache, or one of this input's own outside a composer. */
export function useMentionSearchCache(): MentionSearchCache {
  const shared = useContext(MentionSearchContext);
  const own = useCreateMentionSearchCache();
  return shared ?? own;
}
