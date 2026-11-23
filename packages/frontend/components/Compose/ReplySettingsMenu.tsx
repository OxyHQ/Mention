import type { TFunction } from 'i18next';
import {
  Divider,
  Item,
  Menu,
  Section,
  menu,
  type Child,
  type MenuView,
} from '@oxy.so/bloom-language';
import {
  GRANULAR_REPLY_OPTIONS,
  toggleGranularPermission,
  type ReplyPermission,
} from './replyPermission';

/** Who can reply to a post and whether it can be quoted, and what changes them. */
export interface ReplySettings {
  replyPermission: ReplyPermission[];
  onReplyPermissionChange: (permissions: ReplyPermission[]) => void;
  quotesDisabled: boolean;
  onQuotesDisabledChange: (disabled: boolean) => void;
}

type ReplySettingsRowsProps = ReplySettings & { t: TFunction };

/**
 * The composer's who-can-reply menu around the control that opens it, as
 * Bloom's DropdownMenu (`.menuStyle('dropdown')`: a sheet on native, an
 * anchored menu on web). Its rows are built only while it is open.
 */
export function ReplySettingsMenu(trigger: Child, options: ReplySettingsRowsProps): MenuView {
  return Menu(trigger, ReplySettingsRows(options))
    .menuStyle('dropdown')
    .label(options.t('compose.replySettings.title'));
}

/**
 * Who can reply (anyone or nobody, a choice; or the granular audiences, each
 * a toggle) and whether the post can be quoted. Rows keep the menu open so
 * several audiences can be chosen in one visit.
 */
const ReplySettingsRows = menu(function ReplySettingsRows({
  replyPermission,
  onReplyPermissionChange,
  quotesDisabled,
  onQuotesDisabledChange,
  t,
}: ReplySettingsRowsProps) {
  const isAnyone = replyPermission.includes('anyone');
  const isNobody = replyPermission.includes('nobody');
  const isGranular = !isAnyone && !isNobody;

  return [
    Section(
      Item(t('compose.replySettings.anyone')).tag('anyone').keepOpen(),
      Item(t('compose.replySettings.nobody')).tag('nobody').keepOpen(),
    )
      .title(t('compose.replySettings.whoCanReply'))
      .selection([
        isAnyone ? 'anyone' : isNobody ? 'nobody' : undefined,
        (value) => onReplyPermissionChange([value]),
      ]),
    Divider(),
    GRANULAR_REPLY_OPTIONS.map((option) =>
      Item(t(option.labelKey))
        .checked(isGranular && replyPermission.includes(option.value))
        .keepOpen()
        .onPress(() =>
          onReplyPermissionChange(toggleGranularPermission(replyPermission, option.value)),
        ),
    ),
    Divider(),
    Item(t('compose.replySettings.allowQuotes'))
      .checked(!quotesDisabled)
      .keepOpen()
      .onPress(() => onQuotesDisabledChange(!quotesDisabled)),
  ];
});
