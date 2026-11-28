// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { useTranslation } from 'react-i18next';
import {
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from '@oxy.so/bloom/dropdown-menu';
import {
  GRANULAR_REPLY_OPTIONS,
  toggleGranularPermission,
  type ReplyPermission,
} from './replyPermission';

export interface ReplySettingsMenuItemsProps {
  replyPermission: ReplyPermission[];
  onReplyPermissionChange: (permissions: ReplyPermission[]) => void;
  quotesDisabled: boolean;
  onQuotesDisabledChange: (disabled: boolean) => void;
}

/**
 * Who can reply and whether the post can be quoted, as Bloom menu rows: the
 * composer's own menu and the "Reply options" submenu of a published post's
 * menu. Rows keep the menu open so several audiences can be chosen in one visit.
 */
export function ReplySettingsMenuItems({
  replyPermission,
  onReplyPermissionChange,
  quotesDisabled,
  onQuotesDisabledChange,
}: ReplySettingsMenuItemsProps) {
  const { t } = useTranslation();
  const isAnyone = replyPermission.includes('anyone');
  const isNobody = replyPermission.includes('nobody');
  const isGranular = !isAnyone && !isNobody;

  return (
    <>
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
    </>
  );
}
