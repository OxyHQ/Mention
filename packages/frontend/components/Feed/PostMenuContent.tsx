import { useScreenBack } from '@oxy.so/bloom/screen';
import { Fragment, useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import {
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@oxy.so/bloom/dropdown-menu';
import { RiTeamLine } from '@oxy.so/bloom/icons/RiTeamLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { isMentionCommunity } from '@mention/shared-types/profileUrls';
import type { HydratedPost } from '@mention/shared-types';
import type { ActionMenuAction } from '@/components/common/actionMenuGroups';
import { createCommunityNoteSheets } from '@/components/CommunityNotes/useCommunityNoteSheets';
import { useOperatesAccount } from '@/components/Profile/hooks/useOperatesAccount';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { useCommunityNoteHandlerContext } from '@/context/CommunityNoteHandlersContext';
import { useCommunitiesPreview } from '@/hooks/useCommunitiesPreview';
import { useRouter } from '@/lib/navigation/router';
import { buildPostMenuActions } from './postMenuActions';
import { currentPost, usePostInteractions } from './postInteractions';

interface PostMenuContentProps {
  post: HydratedPost;
  /** The focused post on `/p/<id>`: deleting it also leaves the screen. */
  isPostDetail: boolean;
  /** Feed descriptor, attributed to a save made from the menu. */
  source?: string;
  /** The article reader is row-local state (a modal the row renders). */
  onOpenArticle: () => void;
}

/**
 * The rows of a post's ⋯ menu. Mounted only while the menu is OPEN (the header
 * renders it inside Bloom's `DropdownMenu`), so the services it reads — theme,
 * viewer, router, sheets, the account graph — are resolved once per open, not
 * once per row of a feed (issue #1103). The post is read as the store holds it
 * NOW, falling back to the copy the row rendered.
 */
export function PostMenuContent({
  post: rowPost,
  isPostDetail,
  source,
  onOpenArticle,
}: PostMenuContentProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const { user, canUsePrivateApi } = useAuth();
  const router = useRouter();
  const back = useScreenBack();
  const bottomSheet = useContext(BottomSheetContext);
  const queryClient = useQueryClient();
  const noteHandlers = useCommunityNoteHandlerContext();
  const interactions = usePostInteractions();
  const communitiesPreview = useCommunitiesPreview();

  const post = currentPost(rowPost);
  const { viewerState, community } = post;
  const permissions = post.permissions ?? {};
  const isOwner = viewerState?.isOwner ?? false;
  const sources = post.attachments?.sources ?? [];

  // A moderator of the community hosted here the post is written in gets its
  // moderation actions. Who moderates is the account graph's answer (an active
  // member, the rule the server enforces).
  const hostsCommunity = communitiesPreview && canUsePrivateApi && isMentionCommunity(community);
  const moderatesCommunity = useOperatesAccount({
    accountId: hostsCommunity ? community?.id : undefined,
    accountKind: community?.kind,
  });

  const actions = buildPostMenuActions(
    {
      viewPost: post,
      isOwner,
      isPostDetail,
      canViewInsights: permissions.canViewInsights ?? isOwner,
      canStopSharing: permissions.canStopSharing ?? false,
      isSaved: viewerState?.isSaved ?? false,
      hasArticle: Boolean(post.attachments?.article),
      hasSources: sources.length > 0,
      moderatesCommunity,
      onSave: () => interactions.toggleSave(post, source),
      onOpenArticle,
      onOpenSources: () => interactions.openSources(sources),
    },
    {
      theme,
      t,
      viewerId: user?.id,
      canUsePrivateApi,
      router,
      back,
      bottomSheet,
      queryClient,
    },
  );

  // CrowdSource ownership stays where it was: the handlers decide whether the
  // flow is offered at all, and an author never notes their own post.
  const noteSheets = createCommunityNoteSheets({ bottomSheet, router, handlers: noteHandlers });
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

  const groups: ActionMenuAction[][] = [
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

  return (
    <DropdownMenuContent label={t('postActions.title', { defaultValue: 'Post options' })}>
      {groups.map((group, index) => (
        <Fragment key={group[0].label}>
          {index > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuGroup>
            {group.map((action) => (
              <DropdownMenuItem
                key={action.label}
                leading={action.icon}
                variant={action.color ? 'destructive' : 'default'}
                onPress={action.onPress}
              >
                {action.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </Fragment>
      ))}
    </DropdownMenuContent>
  );
}
