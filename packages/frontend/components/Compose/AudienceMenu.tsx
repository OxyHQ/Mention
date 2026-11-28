import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@oxy.so/bloom/dropdown-menu';

/** Who a new post is for: everyone, or only the people it mentions. */
export type ComposeAudience = 'public' | 'direct';

interface AudienceMenuProps {
  /** The control that opens the menu; it receives the press handler. */
  children: ReactElement;
  audience: ComposeAudience;
  onAudienceChange: (audience: ComposeAudience) => void;
}

/**
 * The composer's audience choice, as a Bloom menu (a sheet on native, an
 * anchored menu on web). A private mention is addressed to the people the post
 * mentions — the server derives the recipients from its mentions.
 */
export function AudienceMenu({ children, audience, onAudienceChange }: AudienceMenuProps) {
  const { t } = useTranslation();
  const label = t('compose.audience.title', { defaultValue: 'Who can see this post' });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild label={label}>
        {children}
      </DropdownMenuTrigger>
      <DropdownMenuContent label={label}>
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={audience}
          onValueChange={(value) => onAudienceChange(value === 'direct' ? 'direct' : 'public')}
        >
          <DropdownMenuRadioItem value="public">
            {t('compose.audience.public', { defaultValue: 'Everyone' })}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="direct">
            {t('compose.audience.direct', {
              defaultValue: 'Private mention: only the people you mention',
            })}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
