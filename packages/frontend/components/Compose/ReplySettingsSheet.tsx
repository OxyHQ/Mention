import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { Toggle } from '@/components/Toggle';
import { BORDER_RADIUS } from '@/styles/shared';

export type ReplyPermission = 'anyone' | 'followers' | 'following' | 'mentioned' | 'nobody';

interface ReplySettingsSheetProps {
  onClose: () => void;
  replyPermission: ReplyPermission;
  onReplyPermissionChange: (permission: ReplyPermission) => void;
  quotesDisabled: boolean;
  onQuotesDisabledChange: (disabled: boolean) => void;
}

type Adjacent = 'leading' | 'trailing' | 'both';

function getPanelRounding(adjacent?: Adjacent) {
  const leading = adjacent === 'leading' || adjacent === 'both';
  const trailing = adjacent === 'trailing' || adjacent === 'both';
  return {
    borderTopLeftRadius: leading ? BORDER_RADIUS.small : BORDER_RADIUS.medium,
    borderTopRightRadius: leading ? BORDER_RADIUS.small : BORDER_RADIUS.medium,
    borderBottomLeftRadius: trailing ? BORDER_RADIUS.small : BORDER_RADIUS.medium,
    borderBottomRightRadius: trailing ? BORDER_RADIUS.small : BORDER_RADIUS.medium,
  };
}

const ReplySettingsSheet: React.FC<ReplySettingsSheetProps> = ({
  onClose,
  replyPermission,
  onReplyPermissionChange,
  quotesDisabled,
  onQuotesDisabledChange,
}) => {
  const theme = useTheme();
  const { t } = useTranslation();

  const isEveryone = replyPermission === 'anyone';
  const isNobody = replyPermission === 'nobody';
  const isGranular = !isEveryone && !isNobody;

  const panelActiveBg = theme.colors.primary + '12';
  const panelInactiveBg = theme.colors.backgroundSecondary;
  const mutedTextColor = theme.colors.textSecondary;

  return (
    <View className="rounded-t-3xl pb-5 bg-background">
      {/* Header */}
      <View className="flex-row items-center px-4 py-2 min-h-[48px] border-b border-border bg-background">
        <Pressable onPress={onClose} className="mr-1.5 z-[1] p-2">
          <Ionicons name="close" size={20} color={theme.colors.text} />
        </Pressable>
        <View className="flex-1" />
      </View>

      {/* Title */}
      <View className="px-4 pt-4 pb-4">
        <Text className="text-2xl font-bold text-foreground">
          {t('Post interaction settings')}
        </Text>
      </View>

      {/* Who can reply */}
      <View className="px-4">
        <Text className="text-base font-medium text-foreground mb-2">
          {t('Who can reply')}
        </Text>

        {/* Everyone / Nobody radio row */}
        <View className="flex-row gap-2 mb-2">
          <Pressable onPress={() => onReplyPermissionChange('anyone')} className="flex-1">
            <View
              className="flex-row items-center gap-2 px-3.5"
              style={{
                minHeight: 56,
                ...getPanelRounding(),
                backgroundColor: isEveryone ? panelActiveBg : panelInactiveBg,
              }}
            >
              <SelectionIndicator variant="radio" selected={isEveryone} primaryColor={theme.colors.primary} mutedColor={mutedTextColor} />
              <Text
                className="text-base"
                style={{
                  fontWeight: isEveryone ? '500' : '400',
                  color: isEveryone ? theme.colors.text : mutedTextColor,
                }}
              >
                {t('Everyone')}
              </Text>
            </View>
          </Pressable>

          <Pressable onPress={() => onReplyPermissionChange('nobody')} className="flex-1">
            <View
              className="flex-row items-center gap-2 px-3.5"
              style={{
                minHeight: 56,
                ...getPanelRounding(),
                backgroundColor: isNobody ? panelActiveBg : panelInactiveBg,
              }}
            >
              <SelectionIndicator variant="radio" selected={isNobody} primaryColor={theme.colors.primary} mutedColor={mutedTextColor} />
              <Text
                className="text-base"
                style={{
                  fontWeight: isNobody ? '500' : '400',
                  color: isNobody ? theme.colors.text : mutedTextColor,
                }}
              >
                {t('Nobody')}
              </Text>
            </View>
          </Pressable>
        </View>

        {/* Granular checkboxes - connected panel group */}
        <View className="gap-1">
          {(['followers', 'following', 'mentioned'] as const).map((option, index, arr) => {
            const isSelected = replyPermission === option;
            const labels: Record<string, string> = {
              followers: t('Your followers'),
              following: t('People you follow'),
              mentioned: t('People you mention'),
            };
            const adjacent: Adjacent =
              index === 0 ? 'trailing' : index === arr.length - 1 ? 'leading' : 'both';

            return (
              <Pressable
                key={option}
                onPress={() => onReplyPermissionChange(option)}
              >
                <View
                  className="flex-row items-center gap-2 px-3.5"
                  style={{
                    minHeight: 56,
                    ...getPanelRounding(adjacent),
                    backgroundColor: isSelected ? panelActiveBg : panelInactiveBg,
                  }}
                >
                  <SelectionIndicator variant="checkbox" selected={isSelected} primaryColor={theme.colors.primary} mutedColor={mutedTextColor} />
                  <Text
                    className="text-base flex-1"
                    style={{
                      fontWeight: isSelected ? '500' : '400',
                      color: isSelected ? theme.colors.text : mutedTextColor,
                    }}
                  >
                    {labels[option]}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* Quote posts toggle */}
      <View className="px-4 pt-4">
        <Pressable onPress={() => onQuotesDisabledChange(!quotesDisabled)}>
          <View
            className="flex-row items-center gap-2 px-3.5"
            style={{
              minHeight: 56,
              ...getPanelRounding(),
              backgroundColor: !quotesDisabled ? panelActiveBg : panelInactiveBg,
            }}
          >
            <View className="flex-row items-center gap-1.5 flex-1">
              <Ionicons
                name="chatbubble-outline"
                size={18}
                color={!quotesDisabled ? theme.colors.text : mutedTextColor}
              />
              <Text
                className="text-base flex-1"
                style={{
                  fontWeight: !quotesDisabled ? '500' : '400',
                  color: !quotesDisabled ? theme.colors.text : mutedTextColor,
                }}
              >
                {t('Allow quote posts')}
              </Text>
            </View>
            <Toggle
              value={!quotesDisabled}
              onValueChange={() => onQuotesDisabledChange(!quotesDisabled)}
            />
          </View>
        </Pressable>
      </View>

      {/* Save button */}
      <View className="px-4 pt-4">
        <Pressable
          onPress={onClose}
          className="items-center justify-center py-3.5"
          style={{
            backgroundColor: theme.colors.primary,
            borderRadius: 8,
          }}
        >
          <Text className="text-base font-semibold text-white">
            {t('Save')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
};

function SelectionIndicator({
  selected,
  variant,
  primaryColor,
  mutedColor,
}: {
  selected: boolean;
  variant: 'radio' | 'checkbox';
  primaryColor: string;
  mutedColor: string;
}) {
  const isRadio = variant === 'radio';
  const size = 24;

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: isRadio ? size / 2 : BORDER_RADIUS.small + 2,
        borderWidth: 1,
        borderColor: selected ? primaryColor : mutedColor,
        backgroundColor: selected ? primaryColor : 'transparent',
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      {selected && (
        isRadio ? (
          <View
            style={{
              width: 12,
              height: 12,
              borderRadius: 6,
              backgroundColor: '#fff',
            }}
          />
        ) : (
          <Ionicons name="checkmark" size={14} color="#fff" />
        )
      )}
    </View>
  );
}

export default ReplySettingsSheet;
