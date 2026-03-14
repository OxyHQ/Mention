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

type Adjacent = 'leading' | 'trailing' | 'both';

function getPanelRounding(adjacent?: Adjacent) {
  const leading = adjacent === 'leading' || adjacent === 'both';
  const trailing = adjacent === 'trailing' || adjacent === 'both';
  return {
    borderTopLeftRadius: leading ? 4 : 8,
    borderTopRightRadius: leading ? 4 : 8,
    borderBottomLeftRadius: trailing ? 4 : 8,
    borderBottomRightRadius: trailing ? 4 : 8,
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

  const panelActiveBg = theme.colors.primary + '12';
  const panelInactiveBg = theme.colors.backgroundTertiary;
  const mutedTextColor = theme.colors.textSecondary;
  const indicatorBorderColor = theme.colors.border;

  return (
    <View style={{ paddingBottom: 20, paddingHorizontal: 16, gap: 16, backgroundColor: theme.colors.background }}>
        {/* Title */}
        <Text
          style={{
            fontSize: 24,
            fontWeight: '700',
            color: theme.colors.text,
          }}
        >
          {t('Post interaction settings')}
        </Text>

        {/* Who can reply section */}
        <View style={{ gap: 8 }}>
          <Text
            style={{
              fontSize: 16,
              fontWeight: '500',
              color: theme.colors.text,
            }}
          >
            {t('Who can reply')}
          </Text>

          {/* Everyone / Nobody radio row */}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Pressable
              onPress={() => onReplyPermissionChange('anyone')}
              style={{ flex: 1 }}
            >
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                  paddingHorizontal: 14,
                  paddingVertical: 14,
                  minHeight: 56,
                  ...getPanelRounding(),
                  backgroundColor: isEveryone ? panelActiveBg : panelInactiveBg,
                }}
              >
                <RadioIndicator
                  selected={isEveryone}
                  primaryColor={theme.colors.primary}
                  borderColor={indicatorBorderColor}
                />
                <Text
                  style={{
                    fontSize: 16,
                    fontWeight: isEveryone ? '500' : '400',
                    color: isEveryone ? theme.colors.text : mutedTextColor,
                  }}
                >
                  {t('Anyone')}
                </Text>
              </View>
            </Pressable>

            <Pressable
              onPress={() => onReplyPermissionChange('nobody')}
              style={{ flex: 1 }}
            >
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                  paddingHorizontal: 14,
                  paddingVertical: 14,
                  minHeight: 56,
                  ...getPanelRounding(),
                  backgroundColor: isNobody ? panelActiveBg : panelInactiveBg,
                }}
              >
                <RadioIndicator
                  selected={isNobody}
                  primaryColor={theme.colors.primary}
                  borderColor={indicatorBorderColor}
                />
                <Text
                  style={{
                    fontSize: 16,
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
          <View style={{ gap: 4 }}>
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
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 8,
                      paddingHorizontal: 14,
                      paddingVertical: 14,
                      minHeight: 56,
                      ...getPanelRounding(adjacent),
                      backgroundColor: isSelected ? panelActiveBg : panelInactiveBg,
                    }}
                  >
                    <CheckboxIndicator
                      selected={isSelected}
                      primaryColor={theme.colors.primary}
                      borderColor={indicatorBorderColor}
                    />
                    <Text
                      style={{
                        fontSize: 16,
                        flex: 1,
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

        {/* Allow quote posts toggle */}
        <Pressable onPress={() => onQuotesDisabledChange(!quotesDisabled)}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              paddingHorizontal: 14,
              paddingVertical: 14,
              minHeight: 56,
              ...getPanelRounding(),
              backgroundColor: !quotesDisabled ? panelActiveBg : panelInactiveBg,
            }}
          >
            <Ionicons
              name="chatbubble-ellipses-outline"
              size={18}
              color={!quotesDisabled ? theme.colors.text : mutedTextColor}
            />
            <Text
              style={{
                fontSize: 16,
                flex: 1,
                fontWeight: !quotesDisabled ? '500' : '400',
                color: !quotesDisabled ? theme.colors.text : mutedTextColor,
              }}
            >
              {t('Allow quote posts')}
            </Text>
            <ToggleSwitch
              value={!quotesDisabled}
              primaryColor={theme.colors.primary}
              mutedColor={theme.colors.border}
            />
          </View>
        </Pressable>

        {/* Save button */}
        <Pressable
          onPress={onClose}
          style={{
            alignItems: 'center',
            justifyContent: 'center',
            paddingVertical: 14,
            borderRadius: 999,
            backgroundColor: theme.colors.primary,
          }}
        >
          <Text
            style={{
              fontSize: 16,
              fontWeight: '600',
              color: '#fff',
            }}
          >
            {t('Save')}
          </Text>
        </Pressable>
    </View>
  );
};

function RadioIndicator({
  selected,
  primaryColor,
  borderColor,
}: {
  selected: boolean;
  primaryColor: string;
  borderColor: string;
}) {
  return (
    <View
      style={{
        width: 25,
        height: 25,
        borderRadius: 12.5,
        borderWidth: 1,
        borderColor: selected ? primaryColor : borderColor,
        backgroundColor: selected ? primaryColor : borderColor + '25',
        justifyContent: 'center',
        alignItems: 'center',
        margin: -1,
      }}
    >
      {selected && (
        <View
          style={{
            width: 12,
            height: 12,
            borderRadius: 6,
            backgroundColor: '#fff',
          }}
        />
      )}
    </View>
  );
}

function CheckboxIndicator({
  selected,
  primaryColor,
  borderColor,
}: {
  selected: boolean;
  primaryColor: string;
  borderColor: string;
}) {
  return (
    <View
      style={{
        width: 24,
        height: 24,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: selected ? primaryColor : borderColor,
        backgroundColor: selected ? primaryColor : borderColor + '25',
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      {selected && (
        <Ionicons name="checkmark" size={14} color="#fff" />
      )}
    </View>
  );
}

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
