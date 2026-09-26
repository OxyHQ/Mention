import React, { useMemo, useEffect } from 'react';
import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { Card } from '@oxy.so/bloom/card';
import { Field } from '@oxy.so/bloom/field';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { useTheme } from '@oxy.so/bloom/theme';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/common/EmptyState';
import { HIT_SLOP_MD } from '@/styles/hitSlop';

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
      <PageHeader
        title={t('compose.sources.heading', { defaultValue: 'Sources' })}
        titleAlign="center"
        safeArea={false}
        leading={
          <Button
            appearance="subtle" tone="neutral"
            iconOnly
            leadingIcon={RiCloseLine}
            onPress={onClose}
            accessibilityLabel={t('common.close', { defaultValue: 'Close' })}
          />
        }
      />

      <Text className="text-[13px] text-muted-foreground mt-3 mb-3 px-4" style={{ lineHeight: 18 }}>
        {t('compose.sources.help', { defaultValue: 'Share links to help readers verify your post.' })}
      </Text>

      {hasInvalidSources && (
        <Text className="text-xs mb-3 px-4" style={{ color: theme.colors.error || '#ff4d4f' }}>
          {t('compose.sources.linksInvalid', { defaultValue: 'Please fix the highlighted links before posting.' })}
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
                <Card
                  key={source.id}
                  appearance="outline"
                  elevation="none"
                  radius="radius-12"
                  className="p-3 gap-2.5"
                  style={isUrlInvalid ? { borderColor: theme.colors.error || '#ff4d4f' } : undefined}
                >
                  <View className="flex-row items-center justify-between">
                    <Text className="text-xs font-semibold tracking-wide uppercase text-muted-foreground">
                      {t('compose.sources.itemLabel', { defaultValue: 'Source {{index}}', index: index + 1 })}
                    </Text>
                    <TouchableOpacity
                      onPress={() => onRemove(source.id)}
                      className="p-1"
                      hitSlop={HIT_SLOP_MD}
                      accessibilityRole="button"
                      accessibilityLabel={t('common.remove', { defaultValue: 'Remove' })}
                    >
                      <RiCloseLine size="sm" fill={theme.colors.textSecondary} />
                    </TouchableOpacity>
                  </View>

                  <TextFieldInput
                    label={t('compose.sources.titlePlaceholder', { defaultValue: 'Source title (optional)' })}
                    value={source.title}
                    onChangeText={(value) => onUpdate(source.id, 'title', value)}
                    maxLength={200}
                    autoCapitalize="sentences"
                    autoCorrect
                  />

                  <Field
                    error={isUrlInvalid ? t('compose.sources.invalidUrl', { defaultValue: 'Enter a valid URL.' }) : null}
                  >
                    <TextFieldInput
                      label={t('compose.sources.urlPlaceholder', { defaultValue: 'https://example.com/article' })}
                      value={source.url}
                      onChangeText={(value) => onUpdate(source.id, 'url', value)}
                      invalid={isUrlInvalid}
                      keyboardType="url"
                      autoCapitalize="none"
                      autoCorrect={false}
                      textContentType="URL"
                      returnKeyType="done"
                    />
                  </Field>
                </Card>
              );
            })}
          </View>
        )}
      </ScrollView>

      {sources.length > 0 && (
        <Button
          className="mt-3 mx-4"
          appearance="subtle" tone="neutral"
          size="large"
          leadingIcon={RiAddLine}
          onPress={onAdd}
          disabled={!canAddMore}
        >
          {t('compose.sources.addAnother', { defaultValue: 'Add another source' })}
        </Button>
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
