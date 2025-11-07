import React, { useMemo, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, TextInput } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { CloseIcon } from '@/assets/icons/close-icon';
import { Plus } from '@/assets/icons/plus-icon';
import { HeaderIconButton } from '@/components/HeaderIconButton';

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
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}
    >
      <View style={[styles.header, { borderBottomColor: theme.colors.border }]}
      >
        <HeaderIconButton onPress={onClose} style={styles.closeButton}>
          <CloseIcon size={20} color={theme.colors.text} />
        </HeaderIconButton>
        <Text style={[styles.title, { color: theme.colors.text }]} pointerEvents="none">
          {t('compose.sources.heading', { defaultValue: 'Sources' })}
        </Text>
        <View style={styles.headerRight} />
      </View>

      <Text style={[styles.description, { color: theme.colors.textSecondary }]}
      >
        {t('compose.sources.help', { defaultValue: 'Share links to help readers verify your post.' })}
      </Text>

      {hasInvalidSources && (
        <Text style={[styles.warningText, { color: theme.colors.error || '#ff4d4f' }]}>
          {t('compose.sources.invalidUrl', { defaultValue: 'Please fix the highlighted links before posting.' })}
        </Text>
      )}

      <ScrollView
        contentContainerStyle={{ paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
      >
        {sources.length === 0 ? (
          <View style={[styles.emptyState, { backgroundColor: theme.colors.backgroundSecondary, borderColor: theme.colors.border }]}>
            <Text style={[styles.emptyStateTitle, { color: theme.colors.text }]}>
              {t('compose.sources.emptyTitle', { defaultValue: 'No sources added yet' })}
            </Text>
            <Text style={[styles.emptyStateSubtitle, { color: theme.colors.textSecondary }]}>
              {t('compose.sources.emptySubtitle', { defaultValue: 'Add credible references to support your post.' })}
            </Text>
            <TouchableOpacity
              onPress={onAdd}
              style={[styles.addButton, {
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.card,
                opacity: canAddMore ? 1 : 0.6,
              }]}
              disabled={!canAddMore}
            >
              <Plus size={16} color={theme.colors.primary} />
              <Text style={[styles.addButtonText, { color: theme.colors.text }]}>
                {t('compose.sources.add', { defaultValue: 'Add source' })}
              </Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.list}>
            {sources.map((source, index) => {
              const isUrlInvalid = source.url.trim().length > 0 && !validateUrl(source.url);

              return (
                <View
                  key={source.id}
                  style={[styles.card, { borderColor: isUrlInvalid ? (theme.colors.error || '#ff4d4f') : theme.colors.border, backgroundColor: theme.colors.card }]}
                >
                  <View style={styles.cardHeader}>
                    <Text style={[styles.cardTitle, { color: theme.colors.textSecondary }]}>
                      {t('compose.sources.itemLabel', { defaultValue: 'Source {{index}}', index: index + 1 })}
                    </Text>
                    <TouchableOpacity onPress={() => onRemove(source.id)} style={styles.removeBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                      <CloseIcon size={16} color={theme.colors.textSecondary} />
                    </TouchableOpacity>
                  </View>

                  <TextInput
                    style={[styles.input, {
                      color: theme.colors.text,
                      borderColor: theme.colors.border,
                      backgroundColor: theme.colors.backgroundSecondary,
                    }]}
                    placeholder={t('compose.sources.titlePlaceholder', { defaultValue: 'Source title (optional)' })}
                    placeholderTextColor={theme.colors.textTertiary}
                    value={source.title}
                    onChangeText={(value) => onUpdate(source.id, 'title', value)}
                    maxLength={200}
                    autoCapitalize="sentences"
                    autoCorrect
                  />

                  <TextInput
                    style={[styles.input, styles.urlInput, {
                      color: theme.colors.text,
                      borderColor: isUrlInvalid ? (theme.colors.error || '#ff4d4f') : theme.colors.border,
                      backgroundColor: theme.colors.backgroundSecondary,
                    }]}
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
                    <Text style={[styles.errorText, { color: theme.colors.error || '#ff4d4f' }]}>
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
          style={[styles.inlineAddButton, {
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.card,
            opacity: canAddMore ? 1 : 0.6,
          }]}
          disabled={!canAddMore}
        >
          <Plus size={16} color={theme.colors.primary} />
          <Text style={[styles.inlineAddText, { color: theme.colors.text }]}>
            {t('compose.sources.addAnother', { defaultValue: 'Add another source' })}
          </Text>
        </TouchableOpacity>
      )}

      {!canAddMore && (
        <Text style={[styles.limitText, { color: theme.colors.textTertiary }]}
        >
          {t('compose.sources.limit', { defaultValue: 'You can add up to 5 sources' })}
        </Text>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingBottom: 24,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    minHeight: 48,
    borderBottomWidth: 1,
    marginBottom: 12,
  },
  title: {
    position: 'absolute',
    left: 0,
    right: 0,
    textAlign: 'center',
    fontSize: 18,
    fontWeight: '700',
    pointerEvents: 'none',
  },
  closeButton: {
    marginRight: 6,
    zIndex: 1,
  },
  headerRight: {
    width: 36,
    height: 36,
    marginLeft: 'auto',
  },
  description: {
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 12,
    paddingHorizontal: 16,
  },
  warningText: {
    fontSize: 12,
    marginBottom: 12,
    paddingHorizontal: 16,
  },
  emptyState: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 16,
  },
  emptyStateTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  emptyStateSubtitle: {
    fontSize: 13,
    textAlign: 'center',
  },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1.5,
    marginTop: 4,
  },
  addButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  list: {
    gap: 12,
    paddingHorizontal: 16,
  },
  card: {
    borderWidth: 1.5,
    borderRadius: 12,
    padding: 12,
    gap: 10,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardTitle: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  removeBtn: {
    padding: 4,
  },
  input: {
    borderRadius: 10,
    borderWidth: 1.5,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  urlInput: {
    fontFamily: 'System',
  },
  errorText: {
    fontSize: 11,
    marginTop: -4,
  },
  inlineAddButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 999,
    borderWidth: 1.5,
    marginTop: 12,
    marginHorizontal: 16,
  },
  inlineAddText: {
    fontSize: 14,
    fontWeight: '600',
  },
  limitText: {
    fontSize: 12,
    textAlign: 'center',
    marginTop: 8,
    paddingHorizontal: 16,
  },
});

export default SourcesSheet;

