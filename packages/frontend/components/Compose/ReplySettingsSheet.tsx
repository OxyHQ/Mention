import { useCallback } from 'react';
import { View } from 'react-native';
import { Text } from '@oxy.so/bloom/typography';
import { useTranslation } from 'react-i18next';
import { Button } from '@oxy.so/bloom/button';
import { RadioGroup } from '@oxy.so/bloom/radio';
import { CheckboxCard } from '@oxy.so/bloom/checkbox';
import { Switch } from '@oxy.so/bloom/switch';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import {
  GRANULAR_REPLY_OPTIONS,
  toggleGranularPermission,
  type GranularReplyPermission,
  type ReplyPermission,
} from './replyPermission';

export type { ReplyPermission };

interface ReplySettingsSheetProps {
  onClose: () => void;
  replyPermission: ReplyPermission[];
  onReplyPermissionChange: (permissions: ReplyPermission[]) => void;
  quotesDisabled: boolean;
  onQuotesDisabledChange: (disabled: boolean) => void;
}

export default function ReplySettingsSheet({
  onClose,
  replyPermission,
  onReplyPermissionChange,
  quotesDisabled,
  onQuotesDisabledChange,
}: ReplySettingsSheetProps) {
  const { t } = useTranslation();
  const isAnyone = replyPermission.includes('anyone');
  const isNobody = replyPermission.includes('nobody');
  const isGranular = !isAnyone && !isNobody;
  const handleRadioPress = useCallback(
    (value: 'anyone' | 'nobody') => {
      onReplyPermissionChange([value]);
    },
    [onReplyPermissionChange],
  );

  const handleCheckboxToggle = useCallback(
    (value: GranularReplyPermission) =>
      onReplyPermissionChange(toggleGranularPermission(replyPermission, value)),
    [replyPermission, onReplyPermissionChange],
  );

  return (
    <View className="px-4 pb-4 gap-3">
      <Text variant="title-2-bold">{t('Post interaction settings')}</Text>
      <RadioGroup
        label={t('Who can reply')}
        value={isAnyone ? 'anyone' : isNobody ? 'nobody' : undefined}
        onValueChange={handleRadioPress}
        variant="card"
        options={[
          { value: 'anyone', label: t('Anyone') },
          { value: 'nobody', label: t('Nobody') },
        ]}
      />
      <View className="gap-1">
        {GRANULAR_REPLY_OPTIONS.map((option) => (
          <CheckboxCard
            key={option.value}
            title={t(option.labelKey)}
            checked={isGranular && replyPermission.includes(option.value)}
            onCheckedChange={() => handleCheckboxToggle(option.value)}
          />
        ))}
      </View>
      <SettingsListGroup>
        <SettingsListItem
          title={t('Allow quote posts')}
          rightElement={
            <Switch
              checked={!quotesDisabled}
              onCheckedChange={(allowed) => onQuotesDisabledChange(!allowed)}
              accessibilityLabel={t('Allow quote posts')}
            />
          }
        />
      </SettingsListGroup>
      <Button size="lg" onPress={onClose}>
        {t('Save')}
      </Button>
    </View>
  );
}
