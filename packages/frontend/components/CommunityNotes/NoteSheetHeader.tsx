import { Text, type TextStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { useColorTokens } from '@oxy.so/bloom/theme';
import { Button, Embed, HStack, Icon, defineTokens, toElement } from '@oxy.so/bloom-language';

/** The row's floor: 52pt, a sheet header's height. */
const header = defineTokens({ space: { minHeight: 52 } });

/**
 * The title, centred across the whole row under the close button: React Native's Text, since
 * its inline insets (`insetInline`, Tailwind's `inset-x-0`) have no modifier.
 */
const TITLE_STYLE: TextStyle = {
  pointerEvents: 'none',
  position: 'absolute',
  insetInline: 0,
  textAlign: 'center',
  fontSize: 17,
  fontWeight: '700',
};

interface NoteSheetHeaderProps {
  title?: string;
  onClose: () => void;
}

/** The close-and-title row every community-note sheet opens with. */
export function NoteSheetHeader({ title, onClose }: NoteSheetHeaderProps) {
  const { t } = useTranslation();
  const colorTokens = useColorTokens();
  return toElement(
    HStack(
      Button(Icon(RiCloseLine))
        .style('subtle')
        .tint('neutral')
        .shape('circle')
        .label(t('common.close', { defaultValue: 'Close' }))
        .onPress(onClose)
        .zIndex('floating'),
      title
        ? Embed(
            <Text style={[TITLE_STYLE, { color: colorTokens.foreground }]} numberOfLines={1}>
              {title}
            </Text>,
          )
        : null,
    )
      .padding('horizontal', 'md')
      .padding('vertical', 'sm')
      .frame({ minHeight: header.space.minHeight })
      .align('center'),
  );
}
