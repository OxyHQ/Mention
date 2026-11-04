import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from '@oxy.so/bloom/dropdown-menu';
import { RiLinkM } from '@oxy.so/bloom/icons/RiLinkM';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { createLogger } from '@oxy.so/core/logger';
import type { HydratedPost, PostSourceLink } from '@mention/shared-types';
import { ReplySettingsMenuItems } from '@/components/Compose/ReplySettingsMenuItems';
import type { ReplyPermission } from '@/components/Compose/replyPermission';
import { usePublisherLanes } from '@/hooks/usePublisherLanes';
import { useRouter } from '@/lib/navigation/router';
import { feedService } from '@/services/feedService';
import { lanesService } from '@/services/lanesService';
import { noteLaneListsChanged } from '@/stores/laneInvalidation';
import { usePostsStore } from '@/stores/postsStore';

const logger = createLogger('PostMenuSubmenus');

/** The radio value of "no lane"; no lane id can collide with it. */
const NO_LANE = '';

/** A source row reads as its title, or as the site it links to. */
function sourceLabel(source: PostSourceLink): string {
  if (source.title?.trim()) return source.title.trim();
  try {
    return new URL(source.url).hostname.replace(/^www\./, '');
  } catch {
    return source.url;
  }
}

/** "Sources": each source the post cites, opened as a link. */
export function PostSourcesSubmenu({ sources }: { sources: PostSourceLink[] }) {
  const theme = useTheme();
  return (
    <>
      {sources.map((source) => (
        <DropdownMenuItem
          key={source.url}
          href={source.url}
          leading={<RiLinkM width={20} height={20} fill={theme.colors.textSecondary} />}
        >
          {sourceLabel(source)}
        </DropdownMenuItem>
      ))}
    </>
  );
}

/**
 * "Reply options": who can reply and whether the post can be quoted, written as
 * each row changes. The rows keep the menu open, so the choice is held here and
 * shown at once; a failed write puts it back.
 */
export function PostReplySettingsSubmenu({ post }: { post: HydratedPost }) {
  const { t } = useTranslation();
  const [replyPermission, setReplyPermission] = useState<ReplyPermission[]>(
    post.metadata?.replyPermission ?? ['anyone'],
  );
  const [quotesDisabled, setQuotesDisabled] = useState(post.metadata?.quotesDisabled ?? false);

  const write = async (
    patch: { replyPermission?: ReplyPermission[]; quotesDisabled?: boolean },
    revert: () => void,
    failure: string,
  ) => {
    try {
      await feedService.updatePostSettings(post.id, patch);
      usePostsStore.getState().updatePostEverywhere(post.id, (prev) => ({
        ...prev,
        metadata: { ...prev.metadata, ...patch },
      }));
    } catch {
      revert();
      toast(failure, { type: 'error' });
    }
  };

  return (
    <ReplySettingsMenuItems
      replyPermission={replyPermission}
      onReplyPermissionChange={(next) => {
        const previous = replyPermission;
        setReplyPermission(next);
        void write(
          { replyPermission: next },
          () => setReplyPermission(previous),
          t('postActions.failedToUpdateReplyPermissions'),
        );
      }}
      quotesDisabled={quotesDisabled}
      onQuotesDisabledChange={(next) => {
        const previous = quotesDisabled;
        setQuotesDisabled(next);
        void write(
          { quotesDisabled: next },
          () => setQuotesDisabled(previous),
          t('postActions.failedToUpdateQuoteSettings'),
        );
      }}
    />
  );
}

/** "Move to lane": the author's lanes, "No lane" first, and a way to manage them. */
export function PostLaneSubmenu({ post }: { post: HydratedPost }) {
  const { t } = useTranslation();
  const router = useRouter();
  const { lanes, isLoading } = usePublisherLanes();

  const moveTo = async (value: string) => {
    const laneId = value === NO_LANE ? null : value;
    try {
      const lane = await lanesService.setPostLane(post.id, laneId);
      usePostsStore.getState().updatePostEverywhere(post.id, (prev) => ({
        ...prev,
        lane: lane ?? undefined,
      }));
      // The chip flips instantly through the store above; WHICH profile tab the
      // post now sits on is server-ordered and paged, so both post-list caches
      // have to be told.
      noteLaneListsChanged('assignment');
    } catch (error) {
      logger.error('Failed to move post to lane', error);
      toast(t('lanes.postActions.moveFailed', { defaultValue: 'Failed to move this post' }), {
        type: 'error',
      });
    }
  };

  return (
    <>
      <DropdownMenuRadioGroup value={post.lane?.id ?? NO_LANE} onValueChange={moveTo}>
        <DropdownMenuRadioItem value={NO_LANE}>
          {t('lanes.picker.none', { defaultValue: 'No lane' })}
        </DropdownMenuRadioItem>
        {lanes.map((lane) => (
          <DropdownMenuRadioItem key={lane.id} value={lane.id}>
            {lane.name}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      {isLoading ? (
        <DropdownMenuItem disabled>
          {t('common.loading', { defaultValue: 'Loading…' })}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuSeparator />
      <DropdownMenuItem onPress={() => router.push('/lanes')}>
        {t('lanes.picker.manage', { defaultValue: 'Manage lanes' })}
      </DropdownMenuItem>
    </>
  );
}
