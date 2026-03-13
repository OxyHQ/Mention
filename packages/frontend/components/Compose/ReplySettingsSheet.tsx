import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { CloseIcon } from '@/assets/icons/close-icon';
import { IconButton } from '@/components/ui/Button';
import { Toggle } from '@/components/Toggle';
import { cn } from '@/lib/utils';

export type ReplyPermission = 'anyone' | 'followers' | 'following' | 'mentioned';

interface ReplySettingsSheetProps {
  onClose: () => void;
  replyPermission: ReplyPermission;
  onReplyPermissionChange: (permission: ReplyPermission) => void;
  reviewReplies: boolean;
  onReviewRepliesChange: (enabled: boolean) => void;
}

const ReplySettingsSheet: React.FC<ReplySettingsSheetProps> = ({
  onClose,
  replyPermission,
  onReplyPermissionChange,
  reviewReplies,
  onReviewRepliesChange,
}) => {
  const theme = useTheme();
  const { t } = useTranslation();

  const options: { value: ReplyPermission; label: string }[] = [
    { value: 'anyone', label: t('Anyone') || 'Anyone' },
    { value: 'followers', label: t('Your followers') || 'Your followers' },
    { value: 'following', label: t('Profiles you follow') || 'Profiles you follow' },
    { value: 'mentioned', label: t('Profiles you mention') || 'Profiles you mention' },
  ];

  return (
    <View className="rounded-t-3xl pb-5 bg-background">
      {/* Header */}
      <View className="flex-row items-center px-4 py-2 min-h-[48px] border-b border-border bg-background">
        <IconButton variant="icon"
          onPress={onClose}
          className="mr-1.5 z-[1]"
        >
          <CloseIcon size={20} color={theme.colors.text} />
        </IconButton>
        <Text className="absolute left-0 right-0 text-center text-lg font-bold text-foreground pointer-events-none">
          {t('Who can reply and quote') || 'Who can reply and quote'}
        </Text>
        <View className="w-9 ml-auto" />
      </View>

      {/* Options */}
      <View className="px-4 pt-2">
        {options.map((option, index) => {
          const isSelected = replyPermission === option.value;
          const isFirst = index === 0;
          const isLast = index === options.length - 1;
          return (
            <TouchableOpacity
              key={option.value}
              className="flex-row justify-between items-center px-4 py-3.5 min-h-[50px]"
              style={{
                backgroundColor: isSelected
                  ? theme.colors.primary + '15'
                  : theme.colors.backgroundSecondary,
                borderTopLeftRadius: isFirst ? 16 : 0,
                borderTopRightRadius: isFirst ? 16 : 0,
                borderBottomLeftRadius: isLast ? 16 : 0,
                borderBottomRightRadius: isLast ? 16 : 0,
                marginBottom: index < options.length - 1 ? 4 : 0,
              }}
              onPress={() => onReplyPermissionChange(option.value)}
              activeOpacity={0.7}
            >
              <Text className={cn(
                "text-base flex-1 text-foreground",
                isSelected ? "font-semibold" : "font-normal"
              )}>
                {option.label}
              </Text>
              {isSelected && (
                <View className="w-5 h-5 rounded-full bg-primary ml-3" />
              )}
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Review Replies Toggle */}
      <View className="px-4 pt-2">
        <View className="flex-row justify-between items-center px-4 py-3.5 rounded-2xl min-h-[50px] bg-secondary">
          <Toggle
            value={reviewReplies}
            onValueChange={onReviewRepliesChange}
            label={t('Review and approve replies') || 'Review and approve replies'}
            containerStyle={{ flex: 1 }}
          />
        </View>
      </View>
    </View>
  );
};

export default ReplySettingsSheet;
