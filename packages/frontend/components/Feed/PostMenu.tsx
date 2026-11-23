/**
 * A post's ⋯ menu in the Bloom language: the menu's groups (`postMenuGroups`),
 * as TAGGED rows. Each row names its
 * action; the menu's `PostMenuActions` resolve the chosen one where the menu is
 * placed (the panel's router, the screen's Back). So the rows are plain data a
 * closed menu builds without a hook of its own, from the app's bound services,
 * and every platform presents them natively: the lens menu on Android, the
 * system menu on iOS (it needs its rows before it opens), Bloom's menu on the
 * web.
 *
 * What only a query knows is read from the query cache, as the hooks' first
 * answer would be: whether the viewer moderates the post's community (no
 * moderation rows until the account graph is known, the same failure direction
 * as `useOperatesAccount`) and the author's lanes. A lane list not yet cached is
 * one row that opens the lane picker, which loads it.
 */
import { lazy, Suspense } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { actions, Divider, Item, Section, Submenu, type MenuChild } from '@oxy.so/bloom-language';
import type { HydratedPost, Lane } from '@mention/shared-types';
import type { AccountNode } from '@oxy.so/core';
import {
  GRANULAR_REPLY_OPTIONS,
  toggleGranularPermission,
} from '@/components/Compose/replyPermission';
import { operatesAccount } from '@/lib/operatedAccounts';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { openExternalLink } from '@/utils/openExternalLink';
import { presentSheet } from '@/utils/sheet';
import { usePublisherLanes } from '@/hooks/usePublisherLanes';
import { useRouter } from '@/lib/navigation/router';
import { postMenuGroups, usePostMenuGroups, type PostMenuContentProps } from './postMenuGroups';
import { moderatedCommunity, type PostMenuServices } from './postMenuServices';
import { changePostSetting, movePostToLane, NO_LANE, sourceLabel } from './PostMenuSubmenus';
import { currentPost } from './postInteractions';
import type { PostMenuEntry, PostMenuSubmenuRows } from './postMenuActions';

const LanePickerSheet = lazy(() => import('@/components/Compose/LanePickerSheet'));

/** What the rows are read with besides the groups: i18n, the author's lanes, Manage lanes. */
interface RowContext {
  t: TFunction;
  /** The author's lanes, or `undefined` while nobody has loaded them. */
  lanes: readonly Lane[] | undefined;
  manageLanes: () => void;
}

/** The rows, tagged, and each tag's action: one reading, so the two always agree. */
interface PostMenuRows {
  rows: MenuChild[];
  actions: Record<string, () => void>;
}

function postMenuRows(groups: PostMenuEntry[][], context: RowContext): PostMenuRows {
  const handlers: Record<string, () => void> = {};
  const item = (title: string, tag: string, run: () => unknown) => {
    handlers[tag] = () => void run();
    return Item(title).tag(tag);
  };
  const rows = groups.map((group) =>
    Section(
      ...group.map((entry): MenuChild => {
        if ('rows' in entry) {
          return Submenu(entry.label, ...submenuRows(entry.rows, context, item)).icon(entry.icon);
        }
        const row = item(entry.label, `entry:${entry.label}`, entry.onPress)
          .icon(entry.icon)
          .iconForeground(entry.iconForeground);
        return entry.destructive ? row.destructive() : row;
      }),
    ),
  );
  return { rows, actions: handlers };
}

type TaggedItem = (title: string, tag: string, run: () => unknown) => ReturnType<typeof Item>;

function submenuRows(
  rows: PostMenuSubmenuRows,
  { t, lanes, manageLanes }: RowContext,
  item: TaggedItem,
): MenuChild[] {
  switch (rows.kind) {
    case 'sources':
      return rows.sources.map((source, index) =>
        item(sourceLabel(source), `source:${index}`, () => openExternalLink(source.url)),
      );
    case 'replySettings':
      return replySettingsRows(rows.post, t, item);
    case 'lane': {
      const post = rows.post;
      const failure = t('lanes.postActions.moveFailed', {
        defaultValue: 'Failed to move this post',
      });
      const move = (value: string) => () => movePostToLane(post, value, failure);
      if (lanes === undefined) {
        // Nobody has loaded the lanes yet: the picker loads and lists them.
        return [
          item(t('lanes.postActions.moveToLane'), 'lane:pick', () => pickLane(post, failure)),
        ];
      }
      const current = post.lane?.id ?? NO_LANE;
      return [
        item(
          t('lanes.picker.none', { defaultValue: 'No lane' }),
          'lane:none',
          move(NO_LANE),
        ).checked(current === NO_LANE),
        ...lanes.map((lane) =>
          item(lane.name, `lane:${lane.id}`, move(lane.id)).checked(current === lane.id),
        ),
        Divider(),
        item(
          t('lanes.picker.manage', { defaultValue: 'Manage lanes' }),
          'lane:manage',
          manageLanes,
        ),
      ];
    }
  }
}

/** The lane picker for a post whose author's lanes are not loaded yet. */
function pickLane(post: HydratedPost, failure: string) {
  void presentSheet((surface) => (
    <Suspense fallback={null}>
      <LanePickerSheet
        selectedLaneId={post.lane?.id ?? null}
        onSelect={(laneId) => {
          surface.dismiss();
          void movePostToLane(post, laneId ?? NO_LANE, failure);
        }}
        onClose={() => surface.dismiss()}
      />
    </Suspense>
  ));
}

/** "Reply options", as `ReplySettingsMenuItems` draws them: who can reply, then quotes. */
function replySettingsRows(post: HydratedPost, t: TFunction, item: TaggedItem): MenuChild[] {
  const permission = post.metadata?.replyPermission ?? ['anyone'];
  const quotesDisabled = post.metadata?.quotesDisabled ?? false;
  const isAnyone = permission.includes('anyone');
  const isNobody = permission.includes('nobody');
  const isGranular = !isAnyone && !isNobody;
  const setPermission = (replyPermission: typeof permission) => () =>
    changePostSetting(
      post.id,
      { replyPermission },
      t('postActions.failedToUpdateReplyPermissions'),
    );
  return [
    Section(
      item(t('compose.replySettings.anyone'), 'reply:anyone', setPermission(['anyone']))
        .checked(isAnyone)
        .keepOpen(),
      item(t('compose.replySettings.nobody'), 'reply:nobody', setPermission(['nobody']))
        .checked(isNobody)
        .keepOpen(),
    ).title(t('compose.replySettings.whoCanReply')),
    Section(
      ...GRANULAR_REPLY_OPTIONS.map((option) =>
        item(
          t(option.labelKey),
          `reply:${option.value}`,
          setPermission(toggleGranularPermission(permission, option.value)),
        )
          .checked(isGranular && permission.includes(option.value))
          .keepOpen(),
      ),
    ),
    Section(
      item(t('compose.replySettings.allowQuotes'), 'reply:quotes', () =>
        changePostSetting(
          post.id,
          { quotesDisabled: !quotesDisabled },
          t('postActions.failedToUpdateQuoteSettings'),
        ),
      )
        .checked(!quotesDisabled)
        .keepOpen(),
    ),
  ];
}

/**
 * The rows of a post's ⋯ menu, described from the app's bound services and the
 * query cache: no hook, and nothing runs.
 */
export function describePostMenu(
  props: PostMenuContentProps,
  services: PostMenuServices,
): MenuChild[] {
  const { queryClient, viewerId } = services;
  const community = moderatedCommunity(currentPost(props.post), services);
  const couldBeOperated = Boolean(community.accountKind) && community.accountKind !== 'personal';
  const moderates =
    couldBeOperated &&
    operatesAccount(
      queryClient.getQueryData<AccountNode[]>(viewerQueryKeys.operatedAccounts(viewerId)),
      community.accountId,
    );
  const groups = postMenuGroups(props, services, moderates);
  return postMenuRows(groups, {
    t: services.t,
    lanes: queryClient.getQueryData<Lane[]>(viewerQueryKeys.ownedLanes(viewerId)),
    manageLanes: () => services.router.push('/lanes'),
  }).rows;
}

/**
 * What a chosen row does: the same groups, with the services where the menu
 * is placed. Runs only when a row is chosen.
 */
export const PostMenuActions = actions(function postMenuActions(props: PostMenuContentProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const groups = usePostMenuGroups(props);
  const offersLanes = groups.some((group) =>
    group.some((entry) => 'rows' in entry && entry.rows.kind === 'lane'),
  );
  const { lanes, isLoading } = usePublisherLanes(undefined, { enabled: offersLanes });
  return postMenuRows(groups, {
    t,
    lanes: isLoading ? undefined : lanes,
    manageLanes: () => router.push('/lanes'),
  }).actions;
});
