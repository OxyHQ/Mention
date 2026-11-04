import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@oxy.so/bloom/dropdown-menu';
import {
  GRANULAR_REPLY_OPTIONS,
  toggleGranularPermission,
  type ReplyPermission,
} from './replyPermission';

interface ReplySettingsMenuProps {
  /** The control that opens the menu; it receives the press handler. */
  children: ReactElement;
  replyPermission: ReplyPermission[];
  onReplyPermissionChange: (permissions: ReplyPermission[]) => void;
  quotesDisabled: boolean;
  onQuotesDisabledChange: (disabled: boolean) => void;
}

/**
 * Who can reply and whether the post can be quoted, as a Bloom menu: a sheet on
 * native, an anchored menu on web. Rows keep the menu open so several audiences
 * can be chosen in one visit.
 */
export function ReplySettingsMenu({
  children,
  replyPermission,
  onReplyPermissionChange,
  quotesDisabled,
  onQuotesDisabledChange,
}: ReplySettingsMenuProps) {
  const { t } = useTranslation();
  const isAnyone = replyPermission.includes('anyone');
  const isNobody = replyPermission.includes('nobody');
  const isGranular = !isAnyone && !isNobody;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild label={t('compose.replySettings.title')}>
        {children}
      </DropdownMenuTrigger>
      <DropdownMenuContent label={t('compose.replySettings.title')}>
        <DropdownMenuLabel>{t('compose.replySettings.whoCanReply')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={isAnyone ? 'anyone' : isNobody ? 'nobody' : undefined}
          onValueChange={(value) => onReplyPermissionChange([value as 'anyone' | 'nobody'])}
        >
          <DropdownMenuRadioItem value="anyone" keepOpen>
            {t('compose.replySettings.anyone')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="nobody" keepOpen>
            {t('compose.replySettings.nobody')}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        {GRANULAR_REPLY_OPTIONS.map((option) => (
          <DropdownMenuCheckboxItem
            key={option.value}
            checked={isGranular && replyPermission.includes(option.value)}
            onCheckedChange={() =>
              onReplyPermissionChange(toggleGranularPermission(replyPermission, option.value))
            }
            keepOpen
          >
            {t(option.labelKey)}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={!quotesDisabled}
          onCheckedChange={(allowed) => onQuotesDisabledChange(!allowed)}
          keepOpen
        >
          {t('compose.replySettings.allowQuotes')}
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
