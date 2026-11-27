import type React from 'react';
import { useMemo, useEffect } from 'react';
import { ScrollView } from 'react-native';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { RiLinkM } from '@oxy.so/bloom/icons/RiLinkM';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/common/EmptyState';

import {
  Button as LButton,
  Embed,
  HStack,
  Header,
  Icon,
  RawText,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';
import { Card } from '@oxy.so/bloom-language/containers';
import { Field as LField, TextField } from '@oxy.so/bloom-language/inputs';

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
                sources.map((source, index) => {
                  const isUrlInvalid = source.url.trim().length > 0 && !validateUrl(source.url);

                  // A source: its fields stacked in the card (`p-3 gap-2.5`), its outline the
                  // error colour while its URL is not one.
                  return Card(
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
                      VStack(Icon(RiCloseLine).size('sm').foreground('muted'))
                        .padding('xs')
                        .onPress(() => onRemove(source.id))
                        .hitSlop('md')
                        .role('button')
                        .label(t('common.remove', { defaultValue: 'Remove' }))
                        .pressFade(),
                    )
                      .align('center')
                      .justify('between'),
                    TextField(
                      [source.title, (value) => onUpdate(source.id, 'title', value)],
                      t('compose.sources.titlePlaceholder', {
                        defaultValue: 'Source title (optional)',
                      }),
                    )
                      .maxLength(200)
                      .autocapitalize('sentences')
                      .autocorrect(true),
                    LField(
                      undefined,
                      Embed(
                        toElement(
                          TextField(
                            [source.url, (value) => onUpdate(source.id, 'url', value)],
                            t('compose.sources.urlPlaceholder', {
                              defaultValue: 'https://example.com/article',
                            }),
                          )
                            .invalid(isUrlInvalid)
                            .keyboard('url')
                            .autocapitalize('none')
                            .autocorrect(false)
                            .textContentType('URL')
                            .submitLabel('done'),
                        ),
                      ),
                    ).error(
                      isUrlInvalid
                        ? t('compose.sources.invalidUrl', {
                            defaultValue: 'Enter a valid URL.',
                          })
                        : null,
                    ),
                  )
                    .style('outline')
                    .elevation('none')
                    .radius('md')
                    .padding('md')
                    .spacing('10')
                    .when(isUrlInvalid, (v) => v.border('error'))
                    .id(source.id);
                }),
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
