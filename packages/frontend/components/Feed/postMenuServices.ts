/**
 * The services a post's ⋯ menu is built from besides the post, resolved where
 * the menu is placed (`usePostMenuServices`) or once for the app by
 * `PostInteractionsBinder`. Its own module so the binder, mounted at startup,
 * does not load the menu itself (`postMenuActions`, its submenus and sheets).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useScreenBack } from '@oxy.so/bloom/screen';
import { useAuth } from '@oxy.so/services/ui/client';
import { isMentionCommunity } from '@mention/shared-types/profileUrls';
import type { HydratedPost } from '@mention/shared-types';
import { useCommunityNoteHandlerContext } from '@/context/CommunityNoteHandlersContext';
import { useCommunitiesPreview } from '@/hooks/useCommunitiesPreview';
import { useRouter } from '@/lib/navigation/router';
import { usePostInteractions } from './postInteractions';
import type { PostMenuDeps } from './postMenuActions';

/**
 * What a post's ⋯ menu is built from besides the post: the app's services
 * (i18n, the viewer, router, Back, the query client, the community-note
 * handlers, the save command) and whether communities are on.
 */
export interface PostMenuServices extends PostMenuDeps {
  noteHandlers: ReturnType<typeof useCommunityNoteHandlerContext>;
  toggleSave: (post: HydratedPost, source?: string) => Promise<void>;
  communitiesPreview: boolean;
}

/**
 * The menu's translations, looked up once per locale. Every feed row's ⋯ has
 * its rows ready before it is pressed (the lens opens them natively), so each
 * row described its whole menu as it mounted: some twenty `t()` lookups a row.
 * The labels are the same for every row in a locale, so the menu reads them
 * through this: the first row looks each one up, the rest reuse it. A new `t`
 * (the language changed) starts afresh.
 */
export function menuTranslations(t: TFunction): TFunction {
  const cache = new Map<string, string>();
  return ((key: string, options?: unknown) => {
    const id = options === undefined ? key : `${key}\u0000${JSON.stringify(options)}`;
    let label = cache.get(id);
    if (label === undefined) {
      label = String(options === undefined ? t(key) : t(key, options as never));
      cache.set(id, label);
    }
    return label;
  }) as TFunction;
}

/** The services where the menu is placed: called only while it is open, or when a row is chosen. */
export function usePostMenuServices(): PostMenuServices {
  const { t: translate } = useTranslation();
  const t = useMemo(() => menuTranslations(translate), [translate]);
  const { user, canUsePrivateApi } = useAuth();
  const router = useRouter();
  const back = useScreenBack();
  const queryClient = useQueryClient();
  const noteHandlers = useCommunityNoteHandlerContext();
  const interactions = usePostInteractions();
  const communitiesPreview = useCommunitiesPreview();
  return {
    t,
    viewerId: user?.id,
    canUsePrivateApi,
    router,
    back,
    queryClient,
    noteHandlers,
    toggleSave: interactions.toggleSave,
    communitiesPreview,
  };
}

/** The community the post is written in, when the viewer could moderate it here. */
export function moderatedCommunity(post: HydratedPost, services: PostMenuServices) {
  const { community } = post;
  const hosts =
    services.communitiesPreview && services.canUsePrivateApi && isMentionCommunity(community);
  return { accountId: hosts ? community?.id : undefined, accountKind: community?.kind };
}
