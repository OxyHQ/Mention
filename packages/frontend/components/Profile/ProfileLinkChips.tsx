import { memo, useCallback, useState } from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';
import * as Clipboard from 'expo-clipboard';
import { CappedChipRow, Chip } from '@oxy.so/bloom/chip';
import { Item } from '@oxy.so/bloom/item';
import { RiArrowRightUpLine } from '@oxy.so/bloom/icons/RiArrowRightUpLine';
import { RiExternalLinkLine } from '@oxy.so/bloom/icons/RiExternalLinkLine';
import { RiLink } from '@oxy.so/bloom/icons/RiLink';
import { useTheme } from '@oxy.so/bloom/theme';
import { supportProviderOf, type ProfileLink } from '@oxy.so/core';
import { applePodcastCollectionId } from '@mention/shared-types';
import { api } from '@/utils/api';
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

/**
 * The outbound arrow after a pill's label, drawn at Bluesky's 12px so it sits
 * with the label instead of at the pill's own icon size.
 */
function OutboundArrow({ support }: { support: boolean }) {
  const { colors } = useTheme();
  return (
    <RiArrowRightUpLine
      size="xs"
      fill={support ? colors.primaryForeground : colors.textSecondary}
    />
  );
}

/**
 * Where a link opens. An Apple Podcasts show opens its show on Syra, which Mention
 * asks for; a link that is not an Apple show, or a show Syra cannot give, opens as
 * written.
 */
async function showUrl(url: string): Promise<string> {
  const collectionId = applePodcastCollectionId(url);
  if (!collectionId) return url;
  try {
    const { data } = await api.get<{ data: { url: string } }>(`/apple-podcasts/${collectionId}`);
    return data.data.url;
  } catch {
    return url;
  }
}

/**
 * The link's site icon, as Clarity serves it for the link's host. Where Clarity
 * has none, or the image fails to load, the pill shows the generic link icon.
 */
function LinkIcon({ link }: { link: ProfileLink }) {
  const { colors } = useTheme();
  const [failed, setFailed] = useState(false);
  if (!link.faviconUrl || failed) {
    return <RiLink size="sm" fill={colors.textSecondary} />;
  }
  return (
    <Image
      source={{ uri: link.faviconUrl }}
      className="size-4 rounded"
      contentFit="cover"
      onError={() => setFailed(true)}
    />
  );
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
      void (async () => {
        const target = await showUrl(url);
        if (onPressLink) onPressLink(target);
        else await openExternalLink(target);
      })();
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
          const support = supportProviderOf(link.url);
          const label = support
            ? t('profile.links.supportOn', {
                provider: support.name,
                defaultValue: 'Support on {{provider}}',
              })
            : chipLabel(link);
          return (
            <Chip
              key={link.id}
              size="md"
              variant={support ? 'solid' : 'subtle'}
              color={support ? 'success' : undefined}
              leading={<LinkIcon link={link} />}
              endIcon={<OutboundArrow support={support !== null} />}
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
