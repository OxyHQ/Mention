import { memo, useCallback } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import * as Clipboard from 'expo-clipboard';
import { CappedChipRow, Chip } from '@oxy.so/bloom/chip';
import { Item } from '@oxy.so/bloom/item';
import { RiExternalLinkLine } from '@oxy.so/bloom/icons/RiExternalLinkLine';
import { RiLink } from '@oxy.so/bloom/icons/RiLink';
import { useTheme } from '@oxy.so/bloom/theme';
import type { ProfileLink } from '@oxy.so/core';
import { presentSheet } from '@/utils/sheet';
import { openExternalLink } from '@/utils/openExternalLink';
import { prettifyUrl } from '@/utils/prettifyUrl';

/** Pills shown before the rest fold behind a "+N" pill (two lines, as on Bluesky). */
const MAX_LINES = 2;

interface ProfileLinkChipsProps {
  links: ProfileLink[];
  /** Defaults to opening the URL with the OS / in-app browser. */
  onPressLink?: (url: string) => void;
}

/** What a link is called on its pill: the owner's title, else the bare address. */
function chipLabel(link: ProfileLink): string {
  return link.title?.trim() || prettifyUrl(link.url);
}

interface LinkActionsSheetProps {
  link: ProfileLink;
  onOpen: (url: string) => void;
  onClose: () => void;
}

/** Long-press content: the full destination, and what to do with it. */
function LinkActionsSheet({ link, onOpen, onClose }: LinkActionsSheetProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();

  return (
    <View className="bg-background px-4 pt-3 pb-2">
      <Item
        leading={<RiExternalLinkLine size="md" fill={colors.textSecondary} />}
        title={t('common.open', 'Open')}
        subtitle={link.url}
        onPress={() => {
          onOpen(link.url);
          onClose();
        }}
      />
      <Item
        leading={<RiLink size="md" fill={colors.textSecondary} />}
        title={t('postActions.copyLink', 'Copy link')}
        onPress={() => {
          void Clipboard.setStringAsync(link.url);
          onClose();
        }}
      />
    </View>
  );
}

/**
 * The profile's links as pills, after the bio (Bluesky's layout): each pill is
 * the link's title or address, a tap opens it, and a long press shows the full
 * destination. Past two lines the rest fold behind a "+N" pill, from Bloom's
 * `CappedChipRow`, which does the measuring so this file does not.
 */
export const ProfileLinkChips = memo(function ProfileLinkChips({
  links,
  onPressLink,
}: ProfileLinkChipsProps) {
  const { t } = useTranslation();
  const open = useCallback(
    (url: string) => {
      if (onPressLink) onPressLink(url);
      else void openExternalLink(url);
    },
    [onPressLink],
  );

  if (links.length === 0) {
    return null;
  }

  return (
    <View className="mb-3">
      <CappedChipRow maxLines={MAX_LINES} accessibilityLabel={t('profile.links.title', 'Links')}>
        {links.map((link) => {
          const label = chipLabel(link);
          return (
            <Chip
              key={link.id}
              size="md"
              variant="subtle"
              leadingIcon={RiLink}
              trailingIcon={RiExternalLinkLine}
              accessibilityLabel={label}
              onPress={() => open(link.url)}
              onLongPress={() =>
                void presentSheet((surface) => (
                  <LinkActionsSheet link={link} onOpen={open} onClose={() => surface.dismiss()} />
                ))
              }
            >
              {label}
            </Chip>
          );
        })}
      </CappedChipRow>
    </View>
  );
});
