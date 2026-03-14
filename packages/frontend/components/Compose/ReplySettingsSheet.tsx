import React, { useRef, useEffect } from 'react';
import { View, Text, Pressable, Animated, Platform } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';

export type ReplyPermission = 'anyone' | 'followers' | 'following' | 'mentioned' | 'nobody';

interface ReplySettingsSheetProps {
  onClose: () => void;
  replyPermission: ReplyPermission;
  onReplyPermissionChange: (permission: ReplyPermission) => void;
  quotesDisabled: boolean;
  onQuotesDisabledChange: (disabled: boolean) => void;
}

const REPLY_OPTIONS: { value: ReplyPermission; labelKey: string }[] = [
  { value: 'anyone', labelKey: 'Everybody' },
  { value: 'followers', labelKey: 'Users who follow you' },
  { value: 'following', labelKey: 'Users you follow' },
  { value: 'mentioned', labelKey: 'Mentioned users only' },
  { value: 'nobody', labelKey: 'Nobody' },
];

const ReplySettingsSheet: React.FC<ReplySettingsSheetProps> = ({
  onClose,
  replyPermission,
  onReplyPermissionChange,
  quotesDisabled,
  onQuotesDisabledChange,
}) => {
  const theme = useTheme();
  const { t } = useTranslation();

  return (
    <View style={{ paddingBottom: 20, paddingHorizontal: 16, gap: 20, backgroundColor: theme.colors.background }}>
      {/* Title */}
      <Text style={{ fontSize: 22, fontWeight: '700', color: theme.colors.text, textAlign: 'center' }}>
        {t('Post interaction settings')}
      </Text>

      {/* Who can reply */}
      <View style={{ gap: 6 }}>
        <Text style={{ fontSize: 13, fontWeight: '600', color: theme.colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, paddingHorizontal: 4 }}>
          {t('Who can reply')}
        </Text>
        <View style={{ borderRadius: 12, backgroundColor: theme.colors.backgroundSecondary, overflow: 'hidden' }}>
          {REPLY_OPTIONS.map((option, index) => {
            const isSelected = replyPermission === option.value;
            return (
              <View key={option.value}>
                {index > 0 && (
                  <View style={{ height: 0.5, marginLeft: 16, backgroundColor: theme.colors.border }} />
                )}
                <Pressable
                  onPress={() => onReplyPermissionChange(option.value)}
                  style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, minHeight: 46 }}>
                    <Text style={{ fontSize: 16, flex: 1, color: theme.colors.text }}>
                      {t(option.labelKey)}
                    </Text>
                    {isSelected && (
                      <Ionicons name="checkmark" size={20} color={theme.colors.primary} />
                    )}
                  </View>
                </Pressable>
              </View>
            );
          })}
        </View>
      </View>

      {/* Quote posts */}
      <View style={{ gap: 6 }}>
        <Text style={{ fontSize: 13, fontWeight: '600', color: theme.colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, paddingHorizontal: 4 }}>
          {t('Quote posts')}
        </Text>
        <Pressable
          onPress={() => onQuotesDisabledChange(!quotesDisabled)}
          style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 16,
              minHeight: 46,
              borderRadius: 12,
              backgroundColor: theme.colors.backgroundSecondary,
            }}
          >
            <Text style={{ fontSize: 16, flex: 1, color: theme.colors.text }}>
              {t('Allow quote posts')}
            </Text>
            <ToggleSwitch
              value={!quotesDisabled}
              primaryColor={theme.colors.primary}
              mutedColor={theme.colors.border}
            />
          </View>
        </Pressable>
      </View>

      {/* Done button */}
      <Pressable
        onPress={onClose}
        style={({ pressed }) => ({
          alignItems: 'center',
          justifyContent: 'center',
          paddingVertical: 14,
          borderRadius: 999,
          backgroundColor: theme.colors.primary,
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <Text style={{ fontSize: 16, fontWeight: '600', color: '#fff' }}>
          {t('Done')}
        </Text>
      </Pressable>
    </View>
  );
};

function ToggleSwitch({
  value,
  primaryColor,
  mutedColor,
}: {
  value: boolean;
  primaryColor: string;
  mutedColor: string;
}) {
  const switchAnim = useRef(new Animated.Value(value ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(switchAnim, {
      toValue: value ? 1 : 0,
      duration: 200,
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  }, [value, switchAnim]);

  return (
    <View
      style={{
        width: 48,
        height: 28,
        borderRadius: 14,
        padding: 3,
        backgroundColor: value ? primaryColor : mutedColor,
      }}
    >
      <Animated.View
        style={{
          width: 22,
          height: 22,
          borderRadius: 11,
          backgroundColor: '#fff',
          transform: [
            {
              translateX: switchAnim.interpolate({
                inputRange: [0, 1],
                outputRange: [0, 20],
              }),
            },
          ],
        }}
      />
    </View>
  );
}

export default ReplySettingsSheet;
