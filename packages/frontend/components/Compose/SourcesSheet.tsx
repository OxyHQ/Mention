import { tokens } from '@oxy.so/bloom/styles';
import type React from 'react';
import { useMemo, useEffect } from 'react';
import { Text, TouchableOpacity, ScrollView } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { Card } from '@oxy.so/bloom/card';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { RiLinkM } from '@oxy.so/bloom/icons/RiLinkM';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { useTheme } from '@oxy.so/bloom/theme';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/common/EmptyState';

import {
  Button as LButton,
  Embed,
  Field as LField,
  HStack,
  Header,
  Icon,
  RawText,
  TextField,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

type SourceField = 'title' | 'url';

interface SourceItem {
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
    [sources, validateUrl],
  );

  useEffect(() => {
    return () => {
      onClose();
    };
  }, [onClose]);

  return toElement(
    VStack(
      Header(t('compose.sources.heading', { defaultValue: 'Sources' }))
        .titleAlign('center')
        .safeArea(false)
        .toolbarLeading(
          LButton(Icon(RiCloseLine))
            .shape('circle')
            .style('subtle')
            .tint('neutral')
            .onPress(onClose)
            .label(t('common.close', { defaultValue: 'Close' })),
        )
        .inPage(),
      Embed(
        <Text
          className="text-[13px] text-muted-foreground mt-3 mb-3 px-4"
          style={{ lineHeight: 18 }}
        >
          {t('compose.sources.help', {
            defaultValue: 'Share links to help readers verify your post.',
          })}
        </Text>,
      ),
      Embed(
        hasInvalidSources && (
          <Text className="text-xs mb-3 px-4" style={{ color: theme.colors.error || '#ff4d4f' }}>
            {t('compose.sources.linksInvalid', {
              defaultValue: 'Please fix the highlighted links before posting.',
            })}
          </Text>
        ),
      ),
      Embed(
        <ScrollView
          contentContainerStyle={{ paddingBottom: 32 }}
          showsVerticalScrollIndicator={false}
        >
          {sources.length === 0 ? (
            <EmptyState
              title={t('compose.sources.emptyTitle', { defaultValue: 'No sources added yet' })}
              subtitle={t('compose.sources.emptySubtitle', {
                defaultValue: 'Add credible references to support your post.',
              })}
              icon={RiLinkM}
              action={
                canAddMore
                  ? {
                      label: t('compose.sources.add', { defaultValue: 'Add source' }),
                      onPress: onAdd,
                      icon: RiAddLine,
                    }
                  : undefined
              }
            />
          ) : (
            toElement(
              VStack(
                Embed(
                  sources.map((source, index) => {
                    const isUrlInvalid = source.url.trim().length > 0 && !validateUrl(source.url);

                    return (
                      <Card
                        key={source.id}
                        appearance="outline"
                        elevation="none"
                        radius="radius-12"
                        className="p-3 gap-2.5"
                        style={
                          isUrlInvalid
                            ? { borderColor: theme.colors.error || '#ff4d4f' }
                            : undefined
                        }
                      >
                        {toElement(
                          HStack(
                            RawText(
                              t('compose.sources.itemLabel', {
                                defaultValue: 'Source {{index}}',
                                index: index + 1,
                              }),
                            )
                              .font('xs')
                              .leading('16px')
                              .weight('semibold')
                              .tracking('wide')
                              .textCase('uppercase')
                              .foreground('muted'),
                            Embed(
                              <TouchableOpacity
                                onPress={() => onRemove(source.id)}
                                className="p-1"
                                hitSlop={tokens.hitSlop.md}
                                accessibilityRole="button"
                                accessibilityLabel={t('common.remove', { defaultValue: 'Remove' })}
                              >
                                {toElement(Icon(RiCloseLine).size('sm').foreground('muted'))}
                              </TouchableOpacity>,
                            ),
                          )
                            .align('center')
                            .justify('between'),
                        )}
                        {toElement(
                          TextField(
                            [source.title, (value) => onUpdate(source.id, 'title', value)],
                            t('compose.sources.titlePlaceholder', {
                              defaultValue: 'Source title (optional)',
                            }),
                          )
                            .maxLength(200)
                            .autocapitalize('sentences')
                            .autocorrect(true),
                        )}
                        {toElement(
                          LField(
                            undefined,
                            Embed(
                              <TextFieldInput
                                label={t('compose.sources.urlPlaceholder', {
                                  defaultValue: 'https://example.com/article',
                                })}
                                value={source.url}
                                onChangeText={(value) => onUpdate(source.id, 'url', value)}
                                invalid={isUrlInvalid}
                                keyboardType="url"
                                autoCapitalize="none"
                                autoCorrect={false}
                                textContentType="URL"
                                returnKeyType="done"
                              />,
                            ),
                          ).error(
                            isUrlInvalid
                              ? t('compose.sources.invalidUrl', {
                                  defaultValue: 'Enter a valid URL.',
                                })
                              : null,
                          ),
                        )}
                      </Card>
                    );
                  }),
                ),
              )
                .padding('horizontal', 'lg')
                .spacing('md'),
            )
          )}
        </ScrollView>,
      ),
      Embed(
        sources.length > 0 && (
          <Button
            className="mt-3 mx-4"
            appearance="subtle"
            tone="neutral"
            size="lg"
            leadingIcon={RiAddLine}
            onPress={onAdd}
            disabled={!canAddMore}
          >
            {t('compose.sources.addAnother', { defaultValue: 'Add another source' })}
          </Button>
        ),
      ),
      !canAddMore
        ? RawText(t('compose.sources.limit', { defaultValue: 'You can add up to 5 sources' }))
            .padding('horizontal', 'lg')
            .font('xs')
            .leading('16px')
            .textAlign('center')
            .margin('top', 'sm')
            .foreground('textTertiary')
        : null,
    )
      .padding('bottom', '2xl')
      .background('background')
      .flex('1'),
  );
};

export default SourcesSheet;
