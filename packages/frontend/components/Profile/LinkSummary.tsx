import React, { memo, useCallback, useContext } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Item } from '@oxyhq/bloom/item';
import { useTheme } from '@oxyhq/bloom/theme';
import { ChainLink_Stroke2_Corner0_Rounded } from '@oxyhq/bloom/icons';
import type { ProfileLink } from '@oxyhq/core';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { prettifyUrl } from '@/utils/prettifyUrl';
import { openExternalLink } from '@/utils/openExternalLink';

interface LinkSummaryProps {
  links: ProfileLink[];
  /** Defaults to opening the URL with the OS handler. */
  onPressLink?: (url: string) => void;
}

interface LinkSummarySheetProps {
  links: ProfileLink[];
  onPressLink: (url: string) => void;
  onClose: () => void;
}

/**
 * Bottom-sheet content listing every profile link (Linktree-style). Opened from
 * the collapsed `LinkSummary` row through Mention's shared `BottomSheetContext`.
 */
function LinkSummarySheet({ links, onPressLink, onClose }: LinkSummarySheetProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();

  return (
    <View className="bg-background px-4 pt-3 pb-2">
      <Text className="text-foreground text-lg font-bold mb-2">
        {t('profile.links.title')}
      </Text>
      <ScrollView className="max-h-[360px]" showsVerticalScrollIndicator={false}>
        {links.map((link) => (
          <Item
            key={link.id}
            leading={<ChainLink_Stroke2_Corner0_Rounded size="md" fill={colors.textSecondary} />}
            title={link.title || prettifyUrl(link.url)}
            subtitle={prettifyUrl(link.url)}
            onPress={() => {
              onPressLink(link.url);
              onClose();
            }}
          />
        ))}
      </ScrollView>
    </View>
  );
}

/**
 * Instagram-style profile links summary. Renders a compact row — a chain icon,
 * the first link's prettified URL (truncated to one line), and an "and N other(s)"
 * suffix — that opens a bottom sheet listing every link when tapped. Renders
 * nothing when there are no links.
 */
export const LinkSummary = memo(function LinkSummary({ links, onPressLink }: LinkSummaryProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const bottomSheet = useContext(BottomSheetContext);

  const openSheet = useCallback(() => {
    bottomSheet.setBottomSheetContent(
      <LinkSummarySheet
        links={links}
        onPressLink={onPressLink ?? ((url) => openExternalLink(url))}
        onClose={() => bottomSheet.openBottomSheet(false)}
      />,
    );
    bottomSheet.openBottomSheet(true);
  }, [bottomSheet, links, onPressLink]);

  if (links.length === 0) {
    return null;
  }

  const extraCount = links.length - 1;

  return (
    <Pressable
      className="flex-row items-center gap-1 mb-3"
      onPress={openSheet}
      accessibilityRole="button"
      accessibilityLabel={t('profile.links.title')}
    >
      <ChainLink_Stroke2_Corner0_Rounded size="sm" fill={colors.textSecondary} />
      <Text className="text-primary text-[15px] shrink" numberOfLines={1}>
        {prettifyUrl(links[0].url)}
      </Text>
      {extraCount > 0 && (
        <Text className="text-muted-foreground text-[15px] shrink-0" numberOfLines={1}>
          {t(extraCount === 1 ? 'profile.links.other' : 'profile.links.others', { count: extraCount })}
        </Text>
      )}
    </Pressable>
  );
});
