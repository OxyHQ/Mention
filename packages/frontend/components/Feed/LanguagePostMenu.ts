/**
 * A post's ⋯ menu in the Bloom language: the same groups as the JSX row's
 * `PostMenuContent` (`usePostMenuGroups`), as rows each platform presents
 * natively (the lens menu on Android, the system menu on iOS, Bloom's menu on
 * the web). The body runs only while the menu is open.
 */
import { isValidElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Divider,
  Item,
  menu,
  Section,
  Submenu,
  type IconComponent,
  type MenuChild,
} from '@oxy.so/bloom-language';
import type { HydratedPost } from '@mention/shared-types';
import {
  GRANULAR_REPLY_OPTIONS,
  toggleGranularPermission,
} from '@/components/Compose/replyPermission';
import { usePublisherLanes } from '@/hooks/usePublisherLanes';
import { useRouter } from '@/lib/navigation/router';
import { openExternalLink } from '@/utils/openExternalLink';
import { usePostMenuGroups, type PostMenuContentProps } from './PostMenuContent';
import { changePostSetting, movePostToLane, NO_LANE, sourceLabel } from './PostMenuSubmenus';
import type { PostMenuEntry, PostMenuSubmenuRows } from './postMenuActions';

type T = ReturnType<typeof useTranslation>['t'];
type Lanes = ReturnType<typeof usePublisherLanes>;

/** An entry's glyph is a Bloom icon element; the menu draws its component in its own ink. */
function glyphOf(icon: ReactNode): IconComponent | undefined {
  return isValidElement(icon) && typeof icon.type !== 'string'
    ? (icon.type as IconComponent)
    : undefined;
}

function withGlyph<V extends { icon(icon: IconComponent): V }>(row: V, icon: ReactNode): V {
  const glyph = glyphOf(icon);
  return glyph ? row.icon(glyph) : row;
}

export const PostMenu = menu(function PostMenu(props: PostMenuContentProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const groups = usePostMenuGroups(props);
  const offersLanes = groups.some((group) =>
    group.some((entry) => 'rows' in entry && entry.rows.kind === 'lane'),
  );
  const lanes = usePublisherLanes(undefined, { enabled: offersLanes });
  return groups.map((group) =>
    Section(
      ...group.map((entry) =>
        entryRow(entry, { t, lanes, manageLanes: () => router.push('/lanes') }),
      ),
    ),
  );
});

interface RowContext {
  t: T;
  lanes: Lanes;
  manageLanes: () => void;
}

function entryRow(entry: PostMenuEntry, context: RowContext): MenuChild {
  if ('rows' in entry) {
    return withGlyph(Submenu(entry.label, ...submenuRows(entry.rows, context)), entry.icon);
  }
  const row = withGlyph(Item(entry.label), entry.icon).onPress(entry.onPress);
  return entry.color ? row.destructive() : row;
}

function submenuRows(
  rows: PostMenuSubmenuRows,
  { t, lanes, manageLanes }: RowContext,
): MenuChild[] {
  switch (rows.kind) {
    case 'sources':
      return rows.sources.map((source) =>
        Item(sourceLabel(source)).onPress(() => openExternalLink(source.url)),
      );
    case 'replySettings':
      return replySettingsRows(rows.post, t);
    case 'lane': {
      const current = rows.post.lane?.id ?? NO_LANE;
      const failure = t('lanes.postActions.moveFailed', {
        defaultValue: 'Failed to move this post',
      });
      const choose = (value: string) => () => movePostToLane(rows.post, value, failure);
      return [
        Item(t('lanes.picker.none', { defaultValue: 'No lane' }))
          .checked(current === NO_LANE)
          .onPress(choose(NO_LANE)),
        ...lanes.lanes.map((lane) =>
          Item(lane.name)
            .checked(current === lane.id)
            .onPress(choose(lane.id)),
        ),
        lanes.isLoading ? Item(t('common.loading', { defaultValue: 'Loading…' })).disabled() : null,
        Divider(),
        Item(t('lanes.picker.manage', { defaultValue: 'Manage lanes' })).onPress(manageLanes),
      ];
    }
  }
}

/** "Reply options", as `ReplySettingsMenuItems` draws them: who can reply, then quotes. */
function replySettingsRows(post: HydratedPost, t: T): MenuChild[] {
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
      Item(t('compose.replySettings.anyone'))
        .checked(isAnyone)
        .keepOpen()
        .onPress(setPermission(['anyone'])),
      Item(t('compose.replySettings.nobody'))
        .checked(isNobody)
        .keepOpen()
        .onPress(setPermission(['nobody'])),
    ).title(t('compose.replySettings.whoCanReply')),
    Section(
      ...GRANULAR_REPLY_OPTIONS.map((option) =>
        Item(t(option.labelKey))
          .checked(isGranular && permission.includes(option.value))
          .keepOpen()
          .onPress(setPermission(toggleGranularPermission(permission, option.value))),
      ),
    ),
    Section(
      Item(t('compose.replySettings.allowQuotes'))
        .checked(!quotesDisabled)
        .keepOpen()
        .onPress(() =>
          changePostSetting(
            post.id,
            { quotesDisabled: !quotesDisabled },
            t('postActions.failedToUpdateQuoteSettings'),
          ),
        ),
    ),
  ];
}
