import React from 'react';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '@oxy.so/bloom/button';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';

interface NoteSheetHeaderProps {
  title?: string;
  onClose: () => void;
}

/** The close-and-title row every community-note sheet opens with (same shape as `PostSourcesSheet`). */
export function NoteSheetHeader({ title, onClose }: NoteSheetHeaderProps) {
  const { t } = useTranslation();
  return (
    <View className="min-h-[52px] flex-row items-center px-3 py-2">
      <Button
        appearance="subtle" tone="neutral"
        iconOnly
        leadingIcon={RiCloseLine}
        accessibilityLabel={t('common.close', { defaultValue: 'Close' })}
        onPress={onClose}
        className="z-10"
      />
      {title ? (
        <Text
          className="text-foreground pointer-events-none absolute inset-x-0 text-center text-[17px] font-bold"
          numberOfLines={1}
        >
          {title}
        </Text>
      ) : null}
    </View>
  );
}
