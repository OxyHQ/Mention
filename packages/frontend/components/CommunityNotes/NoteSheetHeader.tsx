import { useTranslation } from 'react-i18next';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { Button, HStack, Icon, RawText, defineTokens, toElement } from '@oxy.so/bloom-language';

/** The row's floor: 52pt, a sheet header's height. */
const header = defineTokens({ space: { minHeight: 52 } });

interface NoteSheetHeaderProps {
  title?: string;
  onClose: () => void;
}

/** The close-and-title row every community-note sheet opens with. */
export function NoteSheetHeader({ title, onClose }: NoteSheetHeaderProps) {
  const { t } = useTranslation();
  return toElement(
    HStack(
      Button(Icon(RiCloseLine))
        .style('subtle')
        .tint('neutral')
        .shape('circle')
        .label(t('common.close', { defaultValue: 'Close' }))
        .onPress(onClose)
        .zIndex('floating'),
      // The title, centred across the whole row under the close button (Tailwind's `inset-x-0`).
      title
        ? RawText(title)
            .font('lg')
            .weight('bold')
            .textAlign('center')
            .foreground('foreground')
            .position({ horizontal: 'none' })
            .allowsHitTesting(false)
            .lines(1)
        : null,
    )
      .padding('horizontal', 'md')
      .padding('vertical', 'sm')
      .frame({ minHeight: header.space.minHeight })
      .align('center'),
  );
}
