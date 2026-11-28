import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@oxy.so/bloom/dropdown-menu';
import { ReplySettingsMenuItems, type ReplySettingsMenuItemsProps } from './ReplySettingsMenuItems';

interface ReplySettingsMenuProps extends ReplySettingsMenuItemsProps {
  /** The control that opens the menu; it receives the press handler. */
  children: ReactElement;
}

/**
 * The composer's who-can-reply menu: a sheet on native, an anchored menu on web.
 */
export function ReplySettingsMenu({ children, ...settings }: ReplySettingsMenuProps) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild label={t('compose.replySettings.title')}>
        {children}
      </DropdownMenuTrigger>
      <DropdownMenuContent label={t('compose.replySettings.title')}>
        <ReplySettingsMenuItems {...settings} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
