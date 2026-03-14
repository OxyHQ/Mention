import React from 'react';
import { View, Text, Pressable, Switch } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { cn } from '@/lib/utils';

export type ReplyPermission = 'anyone' | 'followers' | 'following' | 'mentioned' | 'nobody';

interface ReplySettingsSheetProps {
  onClose: () => void;
  replyPermission: ReplyPermission;
  onReplyPermissionChange: (permission: ReplyPermission) => void;
  quotesDisabled: boolean;
  onQuotesDisabledChange: (disabled: boolean) => void;
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

  const handleEveryonePress = () => {
    onReplyPermissionChange('anyone');
  };

  const handleNobodyPress = () => {
    onReplyPermissionChange('nobody');
  };

  const handleGranularToggle = (option: 'followers' | 'following' | 'mentioned') => {
    // When toggling a granular option, switch to that permission
    onReplyPermissionChange(option);
  };

  return (
    <View className="rounded-t-3xl pb-5 bg-background">
      {/* Header */}
      <View className="flex-row items-center px-4 py-2 min-h-[48px] border-b border-border bg-background">
        <Pressable onPress={onClose} className="mr-1.5 z-[1] p-2">
          <Ionicons name="close" size={20} color={theme.colors.foreground} />
        </Pressable>
        <View className="flex-1" />
      </View>

      {/* Title */}
      <View className="px-4 pt-4 pb-2">
        <Text className="text-2xl font-bold text-foreground">
          {t('Post interaction settings')}
        </Text>
      </View>

      {/* Who can reply */}
      <View className="px-4 pt-2">
        <Text className="text-base font-medium text-foreground mb-2">
          {t('Who can reply')}
        </Text>

        {/* Everyone / Nobody radio row */}
        <View className="flex-row gap-2 mb-2">
          <Pressable
            onPress={handleEveryonePress}
            className="flex-1"
          >
            <View
              className="flex-row items-center justify-center py-3 rounded-xl"
              style={{
                backgroundColor: isEveryone
                  ? theme.colors.primary + '15'
                  : theme.colors.backgroundSecondary,
                borderWidth: isEveryone ? 1.5 : 1,
                borderColor: isEveryone ? theme.colors.primary : theme.colors.border,
              }}
            >
              <View
                className="w-4 h-4 rounded-full mr-2 items-center justify-center"
                style={{
                  borderWidth: isEveryone ? 0 : 1.5,
                  borderColor: theme.colors.textTertiary,
                  backgroundColor: isEveryone ? theme.colors.primary : 'transparent',
                }}
              >
                {isEveryone && (
                  <View className="w-1.5 h-1.5 rounded-full bg-white" />
                )}
              </View>
              <Text
                className={cn(
                  'text-base text-foreground',
                  isEveryone ? 'font-semibold' : 'font-normal'
                )}
              >
                {t('Everyone')}
              </Text>
            </View>
          </Pressable>

          <Pressable
            onPress={handleNobodyPress}
            className="flex-1"
          >
            <View
              className="flex-row items-center justify-center py-3 rounded-xl"
              style={{
                backgroundColor: isNobody
                  ? theme.colors.primary + '15'
                  : theme.colors.backgroundSecondary,
                borderWidth: isNobody ? 1.5 : 1,
                borderColor: isNobody ? theme.colors.primary : theme.colors.border,
              }}
            >
              <View
                className="w-4 h-4 rounded-full mr-2 items-center justify-center"
                style={{
                  borderWidth: isNobody ? 0 : 1.5,
                  borderColor: theme.colors.textTertiary,
                  backgroundColor: isNobody ? theme.colors.primary : 'transparent',
                }}
              >
                {isNobody && (
                  <View className="w-1.5 h-1.5 rounded-full bg-white" />
                )}
              </View>
              <Text
                className={cn(
                  'text-base text-foreground',
                  isNobody ? 'font-semibold' : 'font-normal'
                )}
              >
                {t('Nobody')}
              </Text>
            </View>
          </Pressable>
        </View>

        {/* Granular checkboxes */}
        <View className="rounded-xl overflow-hidden" style={{ backgroundColor: theme.colors.backgroundSecondary }}>
          {(['followers', 'following', 'mentioned'] as const).map((option, index) => {
            const isSelected = replyPermission === option;
            const labels: Record<string, string> = {
              followers: t('Your followers'),
              following: t('People you follow'),
              mentioned: t('People you mention'),
            };

            return (
              <Pressable
                key={option}
                onPress={() => handleGranularToggle(option)}
              >
                <View
                  className="flex-row items-center px-4 py-3.5"
                  style={{
                    backgroundColor: isSelected
                      ? theme.colors.primary + '10'
                      : 'transparent',
                    borderTopWidth: index > 0 ? 0.5 : 0,
                    borderTopColor: theme.colors.border,
                  }}
                >
                  <View
                    className="w-5 h-5 rounded mr-3 items-center justify-center"
                    style={{
                      borderWidth: isSelected ? 0 : 1.5,
                      borderColor: theme.colors.textTertiary,
                      backgroundColor: isSelected ? theme.colors.primary : 'transparent',
                      borderRadius: 4,
                    }}
                  >
                    {isSelected && (
                      <Ionicons name="checkmark" size={14} color="#fff" />
                    )}
                  </View>
                  <Text
                    className={cn(
                      'text-base text-foreground flex-1',
                      isSelected ? 'font-medium' : 'font-normal'
                    )}
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
        <View
          className="flex-row items-center justify-between px-4 py-3.5 rounded-xl"
          style={{ backgroundColor: theme.colors.backgroundSecondary }}
        >
          <View className="flex-row items-center flex-1 mr-3">
            <Ionicons
              name="chatbubble-outline"
              size={18}
              color={theme.colors.textSecondary}
              style={{ marginRight: 10 }}
            />
            <Text className="text-base text-foreground">
              {t('Allow quote posts')}
            </Text>
          </View>
          <Switch
            value={!quotesDisabled}
            onValueChange={(value) => onQuotesDisabledChange(!value)}
            trackColor={{
              false: theme.colors.border,
              true: theme.colors.primary,
            }}
          />
        </View>
      </View>

      {/* Save button */}
      <View className="px-4 pt-4">
        <Pressable
          onPress={onClose}
          className="items-center justify-center py-3.5 rounded-xl"
          style={{ backgroundColor: theme.colors.primary }}
        >
          <Text className="text-base font-semibold text-white">
            {t('Save')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
};

export default ReplySettingsSheet;
