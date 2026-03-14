import React, { useRef, useEffect, useCallback } from 'react';
import { View, Text, Pressable, Animated, Platform } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';

export type ReplyPermission = 'anyone' | 'followers' | 'following' | 'mentioned' | 'nobody';

type Adjacent = 'leading' | 'trailing' | 'both';

type GranularPermission = 'followers' | 'following' | 'mentioned';

const GRANULAR_OPTIONS: { value: GranularPermission; labelKey: string }[] = [
  { value: 'followers', labelKey: 'Your followers' },
  { value: 'following', labelKey: 'People you follow' },
  { value: 'mentioned', labelKey: 'People you mention' },
];

interface ReplySettingsSheetProps {
  onClose: () => void;
  replyPermission: ReplyPermission[];
  onReplyPermissionChange: (permissions: ReplyPermission[]) => void;
  quotesDisabled: boolean;
  onQuotesDisabledChange: (disabled: boolean) => void;
}

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

  const isAnyone = replyPermission.includes('anyone');
  const isNobody = replyPermission.includes('nobody');
  const isGranular = !isAnyone && !isNobody;

  const panelActiveBg = theme.colors.primary + '12';
  const panelInactiveBg = theme.colors.backgroundTertiary;
  const mutedTextColor = theme.colors.textSecondary;
  const indicatorBorderColor = theme.colors.border;

  const handleRadioPress = useCallback((value: 'anyone' | 'nobody') => {
    onReplyPermissionChange([value]);
  }, [onReplyPermissionChange]);

  const handleCheckboxToggle = useCallback((value: 'followers' | 'following' | 'mentioned') => {
    const currentGranular = replyPermission.filter(
      (p): p is 'followers' | 'following' | 'mentioned' =>
        p === 'followers' || p === 'following' || p === 'mentioned'
    );

    let next: ReplyPermission[];
    if (currentGranular.includes(value)) {
      next = currentGranular.filter((p) => p !== value);
    } else {
      next = [...currentGranular, value];
    }

    // If no granular options selected, default back to 'anyone'
    if (next.length === 0) {
      next = ['anyone'];
    }

    onReplyPermissionChange(next);
  }, [replyPermission, onReplyPermissionChange]);

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

        {/* Anyone / Nobody radio row */}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Pressable
            onPress={() => handleRadioPress('anyone')}
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
                backgroundColor: isAnyone ? panelActiveBg : panelInactiveBg,
              }}
            >
              <RadioIndicator
                selected={isAnyone}
                primaryColor={theme.colors.primary}
                borderColor={indicatorBorderColor}
                inactiveBg={panelInactiveBg}
              />
              <Text
                style={{
                  fontSize: 16,
                  fontWeight: isAnyone ? '500' : '400',
                  color: isAnyone ? theme.colors.text : mutedTextColor,
                }}
              >
                {t('Anyone')}
              </Text>
            </View>
          </Pressable>

          <Pressable
            onPress={() => handleRadioPress('nobody')}
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
                inactiveBg={panelInactiveBg}
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
          {GRANULAR_OPTIONS.map((option, index, arr) => {
            const isSelected = isGranular && replyPermission.includes(option.value);
            const adjacent: Adjacent =
              index === 0 ? 'trailing' : index === arr.length - 1 ? 'leading' : 'both';

            return (
              <Pressable
                key={option.value}
                onPress={() => handleCheckboxToggle(option.value)}
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
                    inactiveBg={panelInactiveBg}
                  />
                  <Text
                    style={{
                      fontSize: 16,
                      flex: 1,
                      fontWeight: isSelected ? '500' : '400',
                      color: isSelected ? theme.colors.text : mutedTextColor,
                    }}
                  >
                    {t(option.labelKey)}
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
  inactiveBg,
}: {
  selected: boolean;
  primaryColor: string;
  borderColor: string;
  inactiveBg: string;
}) {
  return (
    <View
      style={{
        width: 25,
        height: 25,
        borderRadius: 12.5,
        borderWidth: 1,
        borderColor: selected ? primaryColor : borderColor,
        backgroundColor: selected ? primaryColor : inactiveBg,
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
  inactiveBg,
}: {
  selected: boolean;
  primaryColor: string;
  borderColor: string;
  inactiveBg: string;
}) {
  return (
    <View
      style={{
        width: 24,
        height: 24,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: selected ? primaryColor : borderColor,
        backgroundColor: selected ? primaryColor : inactiveBg,
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
