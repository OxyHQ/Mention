import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { CloseIcon } from '@/assets/icons/close-icon';
import { HeaderIconButton } from '@/components/HeaderIconButton';
import { Toggle } from '@/components/Toggle';
import { colors } from '@/styles/colors';

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
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: theme.colors.background, borderBottomColor: theme.colors.border }]}>
        <HeaderIconButton 
          onPress={onClose}
          style={styles.closeButton}
        >
          <CloseIcon size={20} color={theme.colors.text} />
        </HeaderIconButton>
        <Text style={[styles.title, { color: theme.colors.text }]} pointerEvents="none">
          {t('Who can reply and quote') || 'Who can reply and quote'}
        </Text>
        <View style={styles.headerRight} />
      </View>

      {/* Options */}
      <View style={styles.optionsWrapper}>
        {options.map((option, index) => {
          const isSelected = replyPermission === option.value;
          const isFirst = index === 0;
          const isLast = index === options.length - 1;
          return (
            <TouchableOpacity
              key={option.value}
              style={[
                styles.option,
                {
                  backgroundColor: isSelected 
                    ? theme.colors.primary + '15' 
                    : theme.colors.backgroundSecondary,
                  borderTopLeftRadius: isFirst ? 16 : 0,
                  borderTopRightRadius: isFirst ? 16 : 0,
                  borderBottomLeftRadius: isLast ? 16 : 0,
                  borderBottomRightRadius: isLast ? 16 : 0,
                  marginBottom: index < options.length - 1 ? 4 : 0,
                }
              ]}
              onPress={() => onReplyPermissionChange(option.value)}
              activeOpacity={0.7}
            >
              <Text style={[
                styles.optionText, 
                { 
                  color: theme.colors.text,
                  fontWeight: isSelected ? '600' : '400',
                }
              ]}>
                {option.label}
              </Text>
              {isSelected && (
                <View style={[styles.checkmarkContainer, { backgroundColor: theme.colors.primary }]} />
              )}
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Review Replies Toggle */}
      <View style={styles.toggleWrapper}>
        <View style={[
          styles.toggleContainer,
          { backgroundColor: theme.colors.backgroundSecondary }
        ]}>
          <Toggle
            value={reviewReplies}
            onValueChange={onReviewRepliesChange}
            label={t('Review and approve replies') || 'Review and approve replies'}
          />
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingBottom: 20,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    minHeight: 48,
    borderBottomWidth: 1,
  },
  title: {
    position: 'absolute',
    left: 0,
    right: 0,
    textAlign: 'center',
    fontSize: 18,
    fontWeight: '700',
    pointerEvents: 'none',
  },
  closeButton: {
    marginRight: 6,
    zIndex: 1,
  },
  headerRight: {
    width: 36,
    marginLeft: 'auto',
  },
  optionsWrapper: {
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  option: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    minHeight: 50,
  },
  optionText: {
    fontSize: 16,
    flex: 1,
  },
  checkmarkContainer: {
    width: 20,
    height: 20,
    borderRadius: 10,
    marginLeft: 12,
  },
  toggleWrapper: {
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  toggleContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 16,
    minHeight: 50,
  },
});

export default ReplySettingsSheet;

