import React, { useRef } from 'react';
import type { TextInputInstance } from 'react-native';
import { InputGroup, InputGroupAddon } from '@oxy.so/bloom/input-group';
import { Textarea } from '@oxy.so/bloom/textarea';
import { useTranslation } from 'react-i18next';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiBarChartHorizontalLine } from '@oxy.so/bloom/icons/RiBarChartHorizontalLine';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import {
  Card,
  Embed,
  HStack,
  Icon,
  RawText,
  TextField,
  VStack,
  type ViewModifier,
  toElement,
  view,
} from '@oxy.so/bloom-language';

interface PollCreatorProps {
  pollTitle: string;
  pollOptions: string[];
  onTitleChange: (title: string) => void;
  onOptionChange: (index: number, value: string) => void;
  onAddOption: () => void;
  onRemoveOption: (index: number) => void;
  onRemove: () => void;
  autoFocus?: boolean;
  /** Where the caller places the card (the composer's inset under the text). */
  look?: ViewModifier;
}

export const PollCreator = view(function PollCreator({
  pollTitle,
  pollOptions,
  onTitleChange,
  onOptionChange,
  onAddOption,
  onRemoveOption,
  onRemove,
  autoFocus = false,
  look,
}: PollCreatorProps) {
  const { t } = useTranslation();
  const pollTitleInputRef = useRef<TextInputInstance | null>(null);

  React.useEffect(() => {
    if (autoFocus) {
      setTimeout(() => {
        pollTitleInputRef.current?.focus();
      }, 50);
    }
  }, [autoFocus]);

  return Card(
    HStack(
      HStack(
        Icon(RiBarChartHorizontalLine).size('18').foreground('primary'),
        RawText(t('compose.poll.create')).font('md').weight('bold').foreground('foreground'),
      )
        .align('center')
        .spacing('6'),
      VStack(Icon(RiCloseLine).size('18').foreground('muted'))
        .padding('xs')
        .onPress(onRemove)
        .hitSlop('md')
        .pressFade(),
    )
      .justify('between')
      .align('center')
      .margin('bottom', '10'),
    Embed(
      <Textarea
        inputRef={pollTitleInputRef}
        accessibilityLabel={t('compose.poll.question')}
        placeholder={t('compose.poll.question')}
        value={pollTitle}
        onChangeText={onTitleChange}
        maxLength={200}
        showCount
        rows={1}
        autoResize
        maxRows={4}
        style={{ marginBottom: 10 }}
      />,
    ),
    VStack(
      Embed(
        pollOptions.map((option, index) => (
          <InputGroup key={index}>
            <InputGroupAddon>
              {toElement(
                VStack(
                  RawText(index + 1)
                    .font('xs')
                    .leading('16px')
                    .weight('bold')
                    .foreground('muted'),
                )
                  .frame({ width: '2xl', height: '2xl' })
                  .background('mutedFill')
                  .corner('infinite')
                  .align('center')
                  .justify('center'),
              )}
            </InputGroupAddon>
            {toElement(
              TextField(
                [option, (value) => onOptionChange(index, value)],
                t(`Option ${index + 1}`),
              ).maxLength(50),
            )}
            {pollOptions.length > 2 && (
              <InputGroupAddon>
                {toElement(
                  VStack(Icon(RiCloseLine).size('sm').foreground('muted'))
                    .padding('xs')
                    .onPress(() => onRemoveOption(index))
                    .hitSlop('md')
                    .role('button')
                    .label(t('common.remove', { defaultValue: 'Remove' }))
                    .pressFade(),
                )}
              </InputGroupAddon>
            )}
          </InputGroup>
        )),
      ),
    )
      .margin('bottom', 'sm')
      .spacing('sm'),
    pollOptions.length < 4
      ? HStack(
          VStack(Icon(RiAddLine).size('sm').foreground('primary'))
            .frame({ width: '2xl', height: '2xl' })
            .background('mutedFill')
            .corner('infinite')
            .align('center')
            .justify('center'),
          RawText(t('compose.poll.addOption'))
            .font('14')
            .leading('20px')
            .weight('semibold')
            .foreground('primary'),
        )
          .align('center')
          .spacing('sm')
          .padding('vertical', '10')
          .padding('horizontal', 'md')
          .border('border', '1.5')
          .borderStyle('dashed')
          .corner('10')
          .margin('bottom', '6')
          .onPress(onAddOption)
          .pressFade('70')
      : null,
    RawText(
      pollOptions.length === 2 ? t('compose.poll.addMoreOptions') : t('compose.poll.minOptions'),
    )
      .font('11')
      .margin('top', '2xs')
      .margin('left', '2xs')
      .foreground('textTertiary'),
  )
    .outline('thin')
    .radius('md')
    .padding('md')
    .margin('top', 'md')
    .margin('right', 'md')
    .modifier(look);
});
