import React, { useCallback, useContext } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { HideIcon } from '@/assets/icons/hide-icon';
import { ShareIcon } from '@/assets/icons/share-icon';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { cn } from '@/lib/utils';

const ICON_SIZE = 20;

interface WidgetItemMenuConfig {
  /** Display title shown at the top of the sheet (e.g. the trend text or room name). */
  title: string;
  /** Hide the item from its widget. */
  onNotInterested: () => void;
  /** Share the item's deep link. */
  onShare: () => void;
}

interface MenuRow {
  icon: React.ReactNode;
  text: string;
  onPress: () => void;
}

function ActionRow({
  icon,
  text,
  onPress,
  isFirst,
  isLast,
}: MenuRow & { isFirst: boolean; isLast: boolean }) {
  return (
    <TouchableOpacity
      className="bg-card flex-row items-center justify-between py-3 px-3.5"
      style={{
        borderTopLeftRadius: isFirst ? 16 : 0,
        borderTopRightRadius: isFirst ? 16 : 0,
        borderBottomLeftRadius: isLast ? 16 : 0,
        borderBottomRightRadius: isLast ? 16 : 0,
        marginBottom: !isLast ? 4 : 0,
      }}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <Text className={cn('text-base font-medium text-foreground')}>{text}</Text>
      <View className="ml-3">{icon}</View>
    </TouchableOpacity>
  );
}

/**
 * Shared 3-dot (⋯) menu used by the Trends and Live Rooms widgets so both are
 * identical. Renders the app's GLOBAL Bloom-backed bottom sheet with two
 * actions: "No me interesa" (hide) and "Compartir" (share).
 */
export function useWidgetItemMenu() {
  const { t } = useTranslation();
  const theme = useTheme();
  const bottomSheet = useContext(BottomSheetContext);

  return useCallback(
    ({ title, onNotInterested, onShare }: WidgetItemMenuConfig) => {
      const rows: MenuRow[] = [
        {
          icon: <HideIcon size={ICON_SIZE} color={theme.colors.textSecondary} />,
          text: t('widgetMenu.notInterested'),
          onPress: () => {
            bottomSheet.openBottomSheet(false);
            onNotInterested();
          },
        },
        {
          icon: <ShareIcon size={ICON_SIZE} color={theme.colors.textSecondary} />,
          text: t('widgetMenu.share'),
          onPress: () => {
            bottomSheet.openBottomSheet(false);
            onShare();
          },
        },
      ];

      bottomSheet.setBottomSheetContent(
        <View className="bg-background p-4 gap-2">
          {title ? (
            <Text
              className="text-muted-foreground text-[13px] font-medium px-1 mb-1"
              numberOfLines={1}
            >
              {title}
            </Text>
          ) : null}
          <View className="mb-1">
            {rows.map((row, index) => (
              <ActionRow
                key={row.text}
                icon={row.icon}
                text={row.text}
                onPress={row.onPress}
                isFirst={index === 0}
                isLast={index === rows.length - 1}
              />
            ))}
          </View>
        </View>,
      );
      bottomSheet.openBottomSheet(true);
    },
    [bottomSheet, t, theme.colors.textSecondary],
  );
}
