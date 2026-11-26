import { Activity, useMemo } from 'react';
import { useAppShellPanel } from '@oxy.so/bloom/app-shell';
import { Platform } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SearchBar } from './SearchBar';
import { WidgetManager } from './widgets/WidgetManager';
import { openExternalLink } from '@/utils/openExternalLink';
import { useTopicRailStore } from '@/stores/topicRailStore';

import { Embed, HStack, RawText, VStack, toElement } from '@oxy.so/bloom-language';

/** The footer's small print: React Native's Text at 12.5px in the theme's muted ink. */
function footerNote(label: string) {
  return RawText(label).foreground('muted').font('12.5');
}

// Static footer links that don't depend on translations — URLs never change
const STATIC_FOOTER_URLS = [
  { key: 'about', url: 'https://oxy.so/mention' },
  { key: 'privacy', url: 'https://oxy.so/company/transparency/policies/privacy' },
  { key: 'terms', url: 'https://oxy.so/company/transparency/policies/terms-of-service' },
  { key: 'cookies', url: 'https://oxy.so/company/transparency/policies/cookies' },
  { key: 'oxy', url: 'https://oxy.so/', label: 'Oxy' },
  // CrowdSource decides Mention's moderation cases (and will own community
  // notes), so readers can see who does. A product name, never translated.
  { key: 'crowdsource', url: 'https://crowdsource.oxy.so/', label: 'CrowdSource' },
] as const;

export function RightBar() {
  const panel = useAppShellPanel();
  const visible = panel.visibilityReady !== false && panel.active !== false;
  return (
    <Activity mode={visible ? 'visible' : 'hidden'}>
      <RightBarContent />
    </Activity>
  );
}

function RightBarContent() {
  const topicTerm = useTopicRailStore((state) => state.term);

  return toElement(
    VStack(
      Embed(<SearchBar />),
      Embed(<WidgetManager screenId="home" topicTerm={topicTerm} />),
      Embed(Platform.OS === 'web' && <RightBarFooter />),
    )
      .padding('horizontal', '14')
      .padding('top', 'lg'),
  );
}

function RightBarFooter() {
  const { t } = useTranslation();

  const footerLinks = useMemo(
    () =>
      STATIC_FOOTER_URLS.map((item) => ({
        label: 'label' in item ? item.label : t(`rightBar.${item.key}`),
        url: item.url,
      })),
    [t],
  );

  return toElement(
    VStack(
      HStack(
        footerLinks.map((link) =>
          footerNote(link.label)
            .padding('right', 'md')
            .padding('bottom', 'xs')
            .cursor('pointer')
            .onPress(() => openExternalLink(link.url))
            .id(link.label),
        ),
      ).wrap(),
      footerNote('Made with ❤️ in the 🌎 by Oxy™.').padding('top', '2xs'),
      /* No legal notice under the links on purpose: "Mention" carries no
                  trademark claim here, and Oxy's work is under its own licenses,
                  not an all-rights-reserved copyright line. */
    ).padding('bottom', 'md'),
  );
}
