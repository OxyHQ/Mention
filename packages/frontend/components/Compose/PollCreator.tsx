import { tokens } from '@oxy.so/bloom/styles';
import React, { useRef } from 'react';
import {
  TouchableOpacity,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
  type TextInputInstance,
} from 'react-native';
import { useColorTokens } from '@oxy.so/bloom/theme';
import { Card } from '@oxy.so/bloom/card';
import { InputGroup, InputGroupAddon } from '@oxy.so/bloom/input-group';
import { Textarea } from '@oxy.so/bloom/textarea';
import { useTranslation } from 'react-i18next';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiBarChartHorizontalLine } from '@oxy.so/bloom/icons/RiBarChartHorizontalLine';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { Embed, HStack, Icon, RawText, TextField, VStack, toElement } from '@oxy.so/bloom-language';

interface PollCreatorProps {
  pollTitle: string;
  pollOptions: string[];
  onTitleChange: (title: string) => void;
  onOptionChange: (index: number, value: string) => void;
  onAddOption: () => void;
  onRemoveOption: (index: number) => void;
  onRemove: () => void;
  style?: StyleProp<ViewStyle>;
  autoFocus?: boolean;
}

export const PollCreator: React.FC<PollCreatorProps> = ({
  pollTitle,
  pollOptions,
  onTitleChange,
  onOptionChange,
  onAddOption,
  onRemoveOption,
  onRemove,
  style,
  autoFocus = false,
}) => {
  const colorTokens = useColorTokens();
  const { t } = useTranslation();
  const pollTitleInputRef = useRef<TextInputInstance | null>(null);

  React.useEffect(() => {
    if (autoFocus) {
      setTimeout(() => {
        pollTitleInputRef.current?.focus();
      }, 50);
    }
  }, [autoFocus]);

  return (
    <Card border="thin" radius="radius-12" style={[styles.pollCreator, style]}>
      {toElement(
        HStack(
          HStack(
            Icon(RiBarChartHorizontalLine).size('18').foreground('primary'),
            RawText(t('compose.poll.create')).font('md').weight('bold').foreground('foreground'),
          )
            .align('center')
            .spacing('6'),
          Embed(
            <TouchableOpacity onPress={onRemove} style={REMOVE} hitSlop={tokens.hitSlop.md}>
              {toElement(Icon(RiCloseLine).size('18').foreground('muted'))}
            </TouchableOpacity>,
          ),
        )
          .justify('between')
          .align('center')
          .margin('bottom', '10'),
      )}
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
      />
      {toElement(
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
                    <TouchableOpacity
                      onPress={() => onRemoveOption(index)}
                      style={REMOVE}
                      hitSlop={tokens.hitSlop.md}
                      accessibilityRole="button"
                      accessibilityLabel={t('common.remove', { defaultValue: 'Remove' })}
                    >
                      {toElement(Icon(RiCloseLine).size('sm').foreground('muted'))}
                    </TouchableOpacity>
                  </InputGroupAddon>
                )}
              </InputGroup>
            )),
          ),
        )
          .margin('bottom', 'sm')
          .spacing('sm'),
      )}
      {pollOptions.length < 4 && (
        <TouchableOpacity
          style={[ADD_OPTION, { borderColor: colorTokens.border }]}
          onPress={onAddOption}
          activeOpacity={0.7}
        >
          {toElement(
            VStack(Icon(RiAddLine).size('sm').foreground('primary'))
              .frame({ width: '2xl', height: '2xl' })
              .background('mutedFill')
              .corner('infinite')
              .align('center')
              .justify('center'),
          )}
          {toElement(
            RawText(t('compose.poll.addOption'))
              .font('14')
              .leading('20px')
              .weight('semibold')
              .foreground('primary'),
          )}
        </TouchableOpacity>
      )}
      {toElement(
        RawText(
          pollOptions.length === 2
            ? t('compose.poll.addMoreOptions')
            : t('compose.poll.minOptions'),
        )
          .font('11')
          .margin('top', '2xs')
          .margin('left', '2xs')
          .foreground('textTertiary'),
      )}
    </Card>
  );
};

/** A remove control's room around its glyph (`p-1`). */
const REMOVE = { padding: tokens.space.xs } satisfies ViewStyle;
/** Tailwind's 2.5 and 1.5 steps, off Bloom's space scale. */
const SPACE_10 = 10;
const SPACE_6 = 6;
/** Add an option: a dashed outline of the row it adds (`flex-row items-center gap-2 py-2.5 px-3 rounded-[10px] border-[1.5px] border-dashed mb-1.5`). */
const ADD_OPTION = {
  flexDirection: 'row',
  alignItems: 'center',
  gap: tokens.space.sm,
  paddingVertical: SPACE_10,
  paddingHorizontal: tokens.space.md,
  borderRadius: SPACE_10,
  borderWidth: 1.5,
  borderStyle: 'dashed',
  marginBottom: SPACE_6,
} satisfies ViewStyle;

const styles = StyleSheet.create({
  pollCreator: {
    padding: 12,
    marginTop: 12,
    marginRight: 12,
  },
});
