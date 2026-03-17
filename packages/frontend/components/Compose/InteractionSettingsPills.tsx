import React, { memo, useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';

interface InteractionSettingsPillsProps {
  replyPermission: string[];
  quotesDisabled: boolean;
  isSensitive: boolean;
  onReplySettingsPress: () => void;
  onSensitiveToggle: () => void;
}

const InteractionSettingsPills = memo<InteractionSettingsPillsProps>(({
  replyPermission,
  quotesDisabled,
  isSensitive,
  onReplySettingsPress,
  onSensitiveToggle,
}) => {
  const theme = useTheme();
  const { t } = useTranslation();

  const anyoneCanInteract = replyPermission.includes('anyone') && !quotesDisabled;

  const replyPillStyle = useMemo(
    () => [styles.pill, { backgroundColor: theme.colors.backgroundSecondary }],
    [theme.colors.backgroundSecondary],
  );

  const replyTextStyle = useMemo(
    () => [styles.pillText, { color: theme.colors.textSecondary }],
    [theme.colors.textSecondary],
  );

  const sensitiveTextStyle = useMemo(
    () => [styles.pillText, { color: isSensitive ? theme.colors.error : theme.colors.textSecondary }],
    [isSensitive, theme.colors.error, theme.colors.textSecondary],
  );

  return (
    <View style={styles.container}>
      <TouchableOpacity
        onPress={onReplySettingsPress}
        activeOpacity={0.7}
        style={replyPillStyle}
      >
        <Ionicons
          name={anyoneCanInteract ? 'earth-outline' : 'people-outline'}
          size={14}
          color={theme.colors.textSecondary}
        />
        <Text numberOfLines={1} style={replyTextStyle}>
          {anyoneCanInteract
            ? t('Anyone can interact')
            : t('Interaction limited')}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        onPress={onSensitiveToggle}
        activeOpacity={0.7}
        style={styles.pill}
      >
        <Ionicons
          name={isSensitive ? 'warning' : 'warning-outline'}
          size={14}
          color={isSensitive ? theme.colors.error : theme.colors.textSecondary}
        />
        <Text style={sensitiveTextStyle}>
          {isSensitive ? t('compose.sensitive.on', 'CW: On') : t('compose.sensitive.off', 'CW')}
        </Text>
      </TouchableOpacity>
    </View>
  );
});

InteractionSettingsPills.displayName = 'InteractionSettingsPills';

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 4,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
  },
  pillText: {
    fontSize: 12,
    fontWeight: '500',
  },
});

export default InteractionSettingsPills;
