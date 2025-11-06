import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Switch } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { CloseIcon } from '@/assets/icons/close-icon';
import { HeaderIconButton } from '@/components/HeaderIconButton';
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
      <View style={[styles.optionsContainer, { backgroundColor: theme.colors.backgroundSecondary }]}>
        {options.map((option, index) => {
          const isSelected = replyPermission === option.value;
          return (
            <TouchableOpacity
              key={option.value}
              style={[
                styles.option,
                {
                  borderBottomWidth: index < options.length - 1 ? 1 : 0,
                  borderBottomColor: theme.colors.border,
                }
              ]}
              onPress={() => onReplyPermissionChange(option.value)}
              activeOpacity={0.6}
            >
              <Text style={[
                styles.optionText, 
                { color: theme.colors.text }
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

      {/* Divider */}
      <View style={styles.divider} />

      {/* Review Replies Toggle */}
      <View style={[styles.toggleContainer, { backgroundColor: theme.colors.backgroundSecondary }]}>
        <View style={styles.toggleContent}>
          <Text style={[styles.toggleLabel, { color: theme.colors.text }]}>
            {t('Review and approve replies') || 'Review and approve replies'}
          </Text>
          <Switch
            value={reviewReplies}
            onValueChange={onReviewRepliesChange}
            trackColor={{ false: theme.colors.border, true: theme.colors.primary }}
            thumbColor={theme.colors.card}
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
  optionsContainer: {
    marginHorizontal: 16,
    marginTop: 4,
    borderRadius: 12,
    overflow: 'hidden',
  },
  option: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    minHeight: 48,
  },
  optionText: {
    fontSize: 16,
    flex: 1,
  },
  checkmarkContainer: {
    width: 18,
    height: 18,
    borderRadius: 9,
    marginLeft: 12,
  },
  divider: {
    height: 4,
  },
  toggleContainer: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginHorizontal: 16,
    marginTop: 4,
    borderRadius: 12,
    backgroundColor: 'transparent',
    minHeight: 48,
    justifyContent: 'center',
  },
  toggleContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  toggleLabel: {
    fontSize: 16,
    flex: 1,
  },
});

export default ReplySettingsSheet;

