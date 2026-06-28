import React, { useState, useCallback } from 'react';
import { View, Text, TextInput, Image, ScrollView, TouchableOpacity } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { CloseIcon } from '@/assets/icons/close-icon';
import { IconButton } from '@/components/ui/Button';

/** Matches the backend cap on `content.media[].alt`. */
const ALT_MAX_LENGTH = 2000;

interface AltTextSheetProps {
  /** Resolved, ready-to-render preview URL for the image being described. */
  imageUrl: string;
  /** Existing alt text for this image (empty when none has been set). */
  initialAlt: string;
  onClose: () => void;
  onSave: (alt: string) => void;
}

/**
 * Bottom-sheet alt-text editor (Bluesky-style). Shows a preview of the image,
 * a multiline description field with a character counter, and a Done action
 * that saves the (trimmed) alt onto the staged media item.
 */
const AltTextSheet: React.FC<AltTextSheetProps> = ({ imageUrl, initialAlt, onClose, onSave }) => {
  const theme = useTheme();
  const { t } = useTranslation();
  const [value, setValue] = useState(initialAlt);

  const handleSave = useCallback(() => {
    onSave(value.trim());
    onClose();
  }, [value, onSave, onClose]);

  return (
    <View className="flex-1 pb-6 bg-background">
      <View className="flex-row items-center px-4 py-2 min-h-[48px] border-b border-border mb-3">
        <IconButton variant="icon" onPress={onClose} className="mr-1.5 z-[1]">
          <CloseIcon size={20} className="text-foreground" />
        </IconButton>
        <Text className="absolute left-0 right-0 text-center text-lg font-bold text-foreground pointer-events-none">
          {t('compose.altText.heading', { defaultValue: 'Alt text' })}
        </Text>
        <View className="w-9 h-9 ml-auto" />
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: 24 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text className="text-[13px] text-muted-foreground mb-3 px-4" style={{ lineHeight: 18 }}>
          {t('compose.altText.help', {
            defaultValue:
              'Describe this image for people who are blind or have low vision, and to add context for everyone.',
          })}
        </Text>

        {imageUrl ? (
          <View className="mx-4 mb-3 rounded-[15px] overflow-hidden border border-border bg-secondary">
            <Image
              source={{ uri: imageUrl }}
              className="w-full"
              style={{ aspectRatio: 16 / 9 }}
              resizeMode="cover"
            />
          </View>
        ) : null}

        <View className="mx-4 rounded-xl border-[1.5px] border-border bg-secondary px-3 py-2.5">
          <TextInput
            className="text-sm text-foreground"
            style={{ minHeight: 96, textAlignVertical: 'top' }}
            placeholder={t('compose.altText.placeholder', { defaultValue: 'Describe esta imagen…' })}
            placeholderTextColor={theme.colors.textTertiary}
            value={value}
            onChangeText={setValue}
            maxLength={ALT_MAX_LENGTH}
            multiline
            autoFocus
            autoCapitalize="sentences"
            autoCorrect
          />
        </View>
        <Text className="text-[11px] text-right text-muted-foreground mt-1.5 px-4">
          {value.length}/{ALT_MAX_LENGTH}
        </Text>
      </ScrollView>

      <TouchableOpacity
        onPress={handleSave}
        className="flex-row items-center justify-center py-3 rounded-full mt-2 mx-4"
        style={{ backgroundColor: theme.colors.primary }}
        activeOpacity={0.85}
      >
        <Text className="text-sm font-semibold" style={{ color: theme.colors.card }}>
          {t('common.done', { defaultValue: 'Done' })}
        </Text>
      </TouchableOpacity>
    </View>
  );
};

export default AltTextSheet;
