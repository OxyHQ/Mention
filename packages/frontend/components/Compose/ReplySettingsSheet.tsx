import React, { useCallback } from 'react';
import { View } from 'react-native';
import { Text } from '@oxy.so/bloom/typography';
import { useTranslation } from 'react-i18next';
import { Button } from '@oxy.so/bloom/button';
import { RadioGroup } from '@oxy.so/bloom/radio';
import { CheckboxCard } from '@oxy.so/bloom/checkbox';
import { Switch } from '@oxy.so/bloom/switch';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';

export type ReplyPermission = 'anyone' | 'followers' | 'following' | 'mentioned' | 'nobody';

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

export default function ReplySettingsSheet({ onClose, replyPermission, onReplyPermissionChange,
  quotesDisabled, onQuotesDisabledChange,
}: ReplySettingsSheetProps) {
  const { t } = useTranslation();
  const isAnyone = replyPermission.includes('anyone');
  const isNobody = replyPermission.includes('nobody');
  const isGranular = !isAnyone && !isNobody;
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
    <View className="px-4 pb-4 gap-3">
      <Text variant="title-2-bold">{t('Post interaction settings')}</Text>
      <RadioGroup
        label={t('Who can reply')}
        value={isAnyone ? 'anyone' : isNobody ? 'nobody' : undefined}
        onValueChange={handleRadioPress}
        variant="card"
        options={[{ value: 'anyone', label: t('Anyone') }, { value: 'nobody', label: t('Nobody') }]}
      />
      <View className="gap-1">
        {GRANULAR_OPTIONS.map(option => <CheckboxCard
          key={option.value}
          title={t(option.labelKey)}
          checked={isGranular && replyPermission.includes(option.value)}
          onCheckedChange={() => handleCheckboxToggle(option.value)}
        />)}
      </View>
      <SettingsListGroup>
        <SettingsListItem title={t('Allow quote posts')} rightElement={
          <Switch checked={!quotesDisabled} onCheckedChange={allowed => onQuotesDisabledChange(!allowed)}
            accessibilityLabel={t('Allow quote posts')} />
        } />
      </SettingsListGroup>
      <Button size="large" onPress={onClose}>{t('Save')}</Button>
    </View>
  );
}
