import { tokens } from '@oxy.so/bloom/styles';
import type React from 'react';
import { useMemo, useEffect } from 'react';
import { TouchableOpacity, ScrollView, type ViewStyle } from 'react-native';
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
  Text as LText,
  TextField,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

/** A source: its fields stacked in the card (`p-3 gap-2.5`). */
const SOURCE_CARD = { padding: tokens.space.md, gap: 10 } satisfies ViewStyle;
/** A remove control's room around its glyph (`p-1`). */
const REMOVE = { padding: tokens.space.xs } satisfies ViewStyle;

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
      RawText(
        t('compose.sources.help', {
          defaultValue: 'Share links to help readers verify your post.',
        }),
      )
        .font('sm')
        .foreground('muted')
        .margin('top', 'md')
        .margin('bottom', 'md')
        .padding('horizontal', 'lg')
        .leading('18px'),
      hasInvalidSources
        ? RawText(
            t('compose.sources.linksInvalid', {
              defaultValue: 'Please fix the highlighted links before posting.',
            }),
          )
            .font('xs')
            .leading('16px')
            .margin('bottom', 'md')
            .padding('horizontal', 'lg')
            .foreground('error')
        : null,
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
                        style={[
                          SOURCE_CARD,
                          isUrlInvalid && { borderColor: theme.colors.error || '#ff4d4f' },
                        ]}
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
                                style={REMOVE}
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
      sources.length > 0
        ? LButton(
            Icon(RiAddLine),
            LText(t('compose.sources.addAnother', { defaultValue: 'Add another source' })),
          )
            .style('subtle')
            .tint('neutral')
            .size('lg')
            .onPress(onAdd)
            .disabled(!canAddMore)
            .margin('horizontal', 'lg')
            // The web's button never drew its top margin; native's did.
            .when('native', (v) => v.margin('top', 'md'))
        : null,
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
