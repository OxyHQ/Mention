import type { TFunction } from 'i18next';
import { Item, Menu, Section, type Child, type MenuView } from '@oxy.so/bloom-language';

/** Who a new post is for: everyone, or only the people it mentions. */
export type ComposeAudience = 'public' | 'direct';

interface AudienceMenuOptions {
  audience: ComposeAudience;
  onAudienceChange: (audience: ComposeAudience) => void;
  t: TFunction;
}

/**
 * The composer's audience choice around the control that opens it, as Bloom's
 * DropdownMenu (`.menuStyle('dropdown')`: a sheet on native, an anchored menu
 * on web): a radio group under its title. A private mention is addressed to the
 * people the post mentions — the server derives the recipients from its mentions.
 */
export function AudienceMenu(
  trigger: Child,
  { audience, onAudienceChange, t }: AudienceMenuOptions,
): MenuView {
  const label = t('compose.audience.title', { defaultValue: 'Who can see this post' });
  return Menu(
    trigger,
    Section(
      Item(t('compose.audience.public', { defaultValue: 'Everyone' })).tag('public'),
      Item(
        t('compose.audience.direct', {
          defaultValue: 'Private mention: only the people you mention',
        }),
      ).tag('direct'),
    )
      .title(label)
      .selection([audience, onAudienceChange]),
  )
    .menuStyle('dropdown')
    .label(label);
}
