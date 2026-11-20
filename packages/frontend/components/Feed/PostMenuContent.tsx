import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@oxy.so/bloom/dropdown-menu';
import { RiTeamLine } from '@oxy.so/bloom/icons/RiTeamLine';
import type { HydratedPost } from '@mention/shared-types';
import { createCommunityNoteSheets } from '@/components/CommunityNotes/useCommunityNoteSheets';
import { useOperatesAccount } from '@/components/Profile/hooks/useOperatesAccount';
import { buildPostMenuActions, type PostMenuEntry } from './postMenuActions';
import { moderatedCommunity, usePostMenuServices, type PostMenuServices } from './postMenuServices';
export type { PostMenuServices } from './postMenuServices';
import { currentPost } from './postInteractions';

export interface PostMenuContentProps {
  post: HydratedPost;
  /** The focused post on `/p/<id>`: deleting it also leaves the screen. */
  isPostDetail: boolean;
  /** Feed descriptor, attributed to a save made from the menu. */
  source?: string;
  /** The article reader is row-local state (a modal the row renders). */
  onOpenArticle: () => void;
  /** Captured by the row so portals retain the originating host. */
  onInsights: () => void;
}

/**
 * The groups of a post's ⋯ menu, from the post as the store holds it NOW
 * (falling back to the copy the row rendered), the services, and whether the
 * viewer moderates its community. A plain function: the JSX row's menu calls it
 * while open (`usePostMenuGroups`), the language row describes its rows with it
 * from the app's bound services, and resolves a chosen row with it again.
 */
export function postMenuGroups(
  { post: rowPost, isPostDetail, source, onOpenArticle, onInsights }: PostMenuContentProps,
  services: PostMenuServices,
  moderatesCommunity: boolean,
): PostMenuEntry[][] {
  const { theme, t, router, noteHandlers } = services;
  const post = currentPost(rowPost);
  const { viewerState } = post;
  const permissions = post.permissions ?? {};
  const isOwner = viewerState?.isOwner ?? false;

  const actions = buildPostMenuActions(
    {
      viewPost: post,
      isOwner,
      isPostDetail,
      canViewInsights: permissions.canViewInsights ?? isOwner,
      canStopSharing: permissions.canStopSharing ?? false,
      isSaved: viewerState?.isSaved ?? false,
      hasArticle: Boolean(post.attachments?.article),
      moderatesCommunity,
      onSave: () => services.toggleSave(post, source),
      onOpenArticle,
      onInsights,
    },
    services,
  );

  // CrowdSource ownership stays where it was: the handlers decide whether the
  // flow is offered at all, and an author never notes their own post.
  const noteSheets = createCommunityNoteSheets({ router, handlers: noteHandlers });
  const communityNoteAction =
    noteSheets.canWrite && !isOwner
      ? [
          {
            icon: <RiTeamLine width={20} height={20} fill={theme.colors.textSecondary} />,
            label: t('communityNotes.menu.add', { defaultValue: 'Add community note' }),
            onPress: () => noteSheets.openWriteFlow(post),
          },
        ]
      : [];

  const groups: PostMenuEntry[][] = [
    actions.insightsAction,
    actions.saveActionGroup,
    actions.stopSharingAction,
    actions.deleteAction,
    actions.articleAction,
    actions.sourcesAction,
    actions.addToListAction,
    communityNoteAction,
    actions.communityModerationAction,
    actions.muteReportAction,
    actions.copyLinkAction,
  ].filter((group) => group.length > 0);

  return groups;
}

/**
 * The groups of a post's ⋯ menu where it is placed. Called only while the menu
 * is OPEN (the JSX row's `PostMenuContent`) or when a row is chosen (the
 * language row's actions), so the services it reads are resolved once per
 * open, not once per row of a feed (issue #1103). Who moderates the post's
 * community is the account graph's answer (an active member, the rule the
 * server enforces).
 */
export function usePostMenuGroups(props: PostMenuContentProps): PostMenuEntry[][] {
  const services = usePostMenuServices();
  const moderatesCommunity = useOperatesAccount(
    moderatedCommunity(currentPost(props.post), services),
  );
  return postMenuGroups(props, services, moderatesCommunity);
}

/** The rows of a post's ⋯ menu, as Bloom's `DropdownMenu` content. */
export function PostMenuContent(props: PostMenuContentProps) {
  const { t } = useTranslation();
  const groups = usePostMenuGroups(props);
  return (
    <DropdownMenuContent label={t('postActions.title', { defaultValue: 'Post options' })}>
      {groups.map((group, index) => (
        <Fragment key={group[0].label}>
          {index > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuGroup>
            {group.map((entry) =>
              'submenu' in entry ? (
                <DropdownMenuSub key={entry.label}>
                  <DropdownMenuSubTrigger leading={entry.icon}>
                    {entry.label}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent label={entry.label}>
                    {entry.submenu}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              ) : (
                <DropdownMenuItem
                  key={entry.label}
                  leading={entry.icon}
                  variant={entry.color ? 'destructive' : 'default'}
                  onPress={entry.onPress}
                >
                  {entry.label}
                </DropdownMenuItem>
              ),
            )}
          </DropdownMenuGroup>
        </Fragment>
      ))}
    </DropdownMenuContent>
  );
}
