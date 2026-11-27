import { memo, useCallback, useState } from 'react';
import { BloomImage } from '@oxy.so/bloom/image';
import { type ImageStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import * as Clipboard from 'expo-clipboard';
import { CappedChipRow } from '@oxy.so/bloom/chip';
import { RiArrowRightUpLine } from '@oxy.so/bloom/icons/RiArrowRightUpLine';
import { RiExternalLinkLine } from '@oxy.so/bloom/icons/RiExternalLinkLine';
import { RiLink } from '@oxy.so/bloom/icons/RiLink';
import { supportProviderOf, type ProfileLink } from '@oxy.so/core';
import { applePodcastCollectionId } from '@mention/shared-types/applePodcast';
import { api } from '@/utils/api';
import { presentSheet } from '@/utils/sheet';
import { openExternalLink } from '@/utils/openExternalLink';
import { prettifyUrl } from '@/utils/prettifyUrl';

import { Embed, Icon, VStack, toElement, Text } from '@oxy.so/bloom-language';
import { Row, Chip as LChip } from '@oxy.so/bloom-language/containers';

/** A site icon: 16pt, its corners rounded 4pt, as `size-4 rounded` drew it. */
const FAVICON_STYLE: ImageStyle = { width: 16, height: 16, borderRadius: 4 };

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
  const [failed, setFailed] = useState(false);
  if (!link.faviconUrl || failed) {
    return toElement(Icon(RiLink).size('sm').foreground('muted'));
  }
  return (
    <BloomImage
      source={{ uri: link.faviconUrl }}
      style={FAVICON_STYLE}
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

  return toElement(
    VStack(
      Row(t('common.open', 'Open'))
        .leadingView(Icon(RiExternalLinkLine).size('md').foreground('muted'))
        .subtitle(link.url)
        .onPress(() => {
          onOpen(link.url);
          onClose();
        }),
      Row(t('postActions.copyLink', 'Copy link'))
        .leadingView(Icon(RiLink).size('md').foreground('muted'))
        .onPress(() => {
          void Clipboard.setStringAsync(link.url);
          onClose();
        }),
    )
      .padding('horizontal', 'lg')
      .padding('top', 'md')
      .padding('bottom', 'sm')
      .background('background'),
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

  return toElement(
    VStack(
      Embed(
        <CappedChipRow maxLines={MAX_LINES} accessibilityLabel={t('profile.links.title', 'Links')}>
          {links.map((link) => {
            const support = supportProviderOf(link.url);
            const label = support
              ? t('profile.links.supportOn', {
                  provider: support.name,
                  defaultValue: 'Support on {{provider}}',
                })
              : chipLabel(link);
            return toElement(
              LChip(
                Embed(<LinkIcon link={link} />),
                Text(label),
                // The outbound arrow after the label, drawn at Bluesky's 12px so it sits
                // with the label instead of at the pill's own icon size.
                Icon(RiArrowRightUpLine)
                  .size('xs')
                  .foreground(support !== null ? 'onPrimary' : 'muted'),
              )
                .size('md')
                .style(support ? 'solid' : 'subtle')
                .tint(support ? 'success' : undefined)
                .label(label)
                .onPress(() => open(link.url))
                .onLongPress(
                  () =>
                    void presentSheet((surface) => (
                      <LinkActionsSheet
                        link={link}
                        onOpen={open}
                        onClose={() => surface.dismiss()}
                      />
                    )),
                ),
              link.id,
            );
          })}
        </CappedChipRow>,
      ),
    ).margin('bottom', 'md'),
  );
});
