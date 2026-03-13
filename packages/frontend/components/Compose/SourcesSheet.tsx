import React, { useMemo, useEffect } from 'react';
import { View, Text, TouchableOpacity, ScrollView, TextInput } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { CloseIcon } from '@/assets/icons/close-icon';
import { Plus } from '@/assets/icons/plus-icon';
import { IconButton } from '@/components/ui/Button';
import { EmptyState } from '@/components/common/EmptyState';

type SourceField = 'title' | 'url';

export interface SourceItem {
  id: string;
  title: string;
  url: string;
}

interface SourcesSheetProps {
  sources: SourceItem[];
  onAdd: () => void;
  onUpdate: (sourceId: string, field: SourceField, value: string) => void;
  onRemove: (sourceId: string) => void;
  onClose: () => void;
  validateUrl: (value: string) => boolean;
  maxSources?: number;
}

const SourcesSheet: React.FC<SourcesSheetProps> = ({
  sources,
  onAdd,
  onUpdate,
  onRemove,
  onClose,
  validateUrl,
  maxSources = 5,
}) => {
  const theme = useTheme();
  const { t } = useTranslation();

  const canAddMore = sources.length < maxSources;
  const hasInvalidSources = useMemo(
    () => sources.some((source) => source.url.trim().length > 0 && !validateUrl(source.url)),
    [sources, validateUrl]
  );

  useEffect(() => {
    return () => {
      onClose();
    };
  }, [onClose]);

  return (
    <View className="flex-1 pb-6 bg-background">
      <View className="flex-row items-center px-4 py-2 min-h-[48px] border-b border-border mb-3">
        <IconButton variant="icon" onPress={onClose} className="mr-1.5 z-[1]">
          <CloseIcon size={20} className="text-foreground" />
        </IconButton>
        <Text className="absolute left-0 right-0 text-center text-lg font-bold text-foreground pointer-events-none">
          {t('compose.sources.heading', { defaultValue: 'Sources' })}
        </Text>
        <View className="w-9 h-9 ml-auto" />
      </View>

      <Text className="text-[13px] text-muted-foreground mb-3 px-4" style={{ lineHeight: 18 }}>
        {t('compose.sources.help', { defaultValue: 'Share links to help readers verify your post.' })}
      </Text>

      {hasInvalidSources && (
        <Text className="text-xs mb-3 px-4" style={{ color: theme.colors.error || '#ff4d4f' }}>
          {t('compose.sources.invalidUrl', { defaultValue: 'Please fix the highlighted links before posting.' })}
        </Text>
      )}

      <ScrollView
        contentContainerStyle={{ paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
      >
        {sources.length === 0 ? (
          <EmptyState
            title={t('compose.sources.emptyTitle', { defaultValue: 'No sources added yet' })}
            subtitle={t('compose.sources.emptySubtitle', { defaultValue: 'Add credible references to support your post.' })}
            icon={{
              name: 'link-outline',
              size: 48,
            }}
            action={canAddMore ? {
              label: t('compose.sources.add', { defaultValue: 'Add source' }),
              onPress: onAdd,
              icon: 'add-outline',
            } : undefined}
          />
        ) : (
          <View className="gap-3 px-4">
            {sources.map((source, index) => {
              const isUrlInvalid = source.url.trim().length > 0 && !validateUrl(source.url);

              return (
                <View
                  key={source.id}
                  className="border-[1.5px] rounded-xl p-3 gap-2.5"
                  style={{
                    borderColor: isUrlInvalid ? (theme.colors.error || '#ff4d4f') : theme.colors.border,
                    backgroundColor: theme.colors.card,
                  }}
                >
                  <View className="flex-row items-center justify-between">
                    <Text className="text-xs font-semibold tracking-wide uppercase text-muted-foreground">
                      {t('compose.sources.itemLabel', { defaultValue: 'Source {{index}}', index: index + 1 })}
                    </Text>
                    <TouchableOpacity onPress={() => onRemove(source.id)} className="p-1" hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                      <CloseIcon size={16} className="text-muted-foreground" />
                    </TouchableOpacity>
                  </View>

                  <TextInput
                    className="rounded-[10px] border-[1.5px] border-border bg-secondary px-3 py-2.5 text-sm text-foreground"
                    placeholder={t('compose.sources.titlePlaceholder', { defaultValue: 'Source title (optional)' })}
                    placeholderTextColor={theme.colors.textTertiary}
                    value={source.title}
                    onChangeText={(value) => onUpdate(source.id, 'title', value)}
                    maxLength={200}
                    autoCapitalize="sentences"
                    autoCorrect
                  />

                  <TextInput
                    className="rounded-[10px] border-[1.5px] bg-secondary px-3 py-2.5 text-sm text-foreground"
                    style={{
                      fontFamily: 'Inter-Regular',
                      borderColor: isUrlInvalid ? (theme.colors.error || '#ff4d4f') : theme.colors.border,
                    }}
                    placeholder={t('compose.sources.urlPlaceholder', { defaultValue: 'https://example.com/article' })}
                    placeholderTextColor={theme.colors.textTertiary}
                    value={source.url}
                    onChangeText={(value) => onUpdate(source.id, 'url', value)}
                    keyboardType="url"
                    autoCapitalize="none"
                    autoCorrect={false}
                    textContentType="URL"
                    returnKeyType="done"
                  />

                  {isUrlInvalid && (
                    <Text className="text-[11px] -mt-1" style={{ color: theme.colors.error || '#ff4d4f' }}>
                      {t('compose.sources.invalidUrl', { defaultValue: 'Enter a valid URL.' })}
                    </Text>
                  )}
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>

      {sources.length > 0 && (
        <TouchableOpacity
          onPress={onAdd}
          className="flex-row items-center justify-center gap-2 py-3 rounded-full border-[1.5px] border-border mt-3 mx-4"
          style={{
            backgroundColor: theme.colors.card,
            opacity: canAddMore ? 1 : 0.6,
          }}
          disabled={!canAddMore}
        >
          <Plus size={16} className="text-primary" />
          <Text className="text-sm font-semibold text-foreground">
            {t('compose.sources.addAnother', { defaultValue: 'Add another source' })}
          </Text>
        </TouchableOpacity>
      )}

      {!canAddMore && (
        <Text className="text-xs text-center mt-2 px-4" style={{ color: theme.colors.textTertiary }}>
          {t('compose.sources.limit', { defaultValue: 'You can add up to 5 sources' })}
        </Text>
      )}
    </View>
  );
};

export default SourcesSheet;
