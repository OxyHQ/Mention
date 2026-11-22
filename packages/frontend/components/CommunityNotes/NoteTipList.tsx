import type React from 'react';
import { useTheme } from '@oxy.so/bloom/theme';
import { Embed, HStack, RawText, VStack, toElement } from '@oxy.so/bloom-language';

type NoteTipIcon = React.ComponentType<{ width?: number; height?: number; fill?: string }>;

export interface NoteTip {
  icon: NoteTipIcon;
  title?: string;
  body: string;
}

/** Icon + text rows used by the tips, "submitted" and "about" sheets. */
export function NoteTipList({ tips }: { tips: NoteTip[] }) {
  const { colors } = useTheme();
  return toElement(
    VStack(
      Embed(
        tips.map((tip) =>
          toElement(
            HStack(
              VStack(Embed(<tip.icon width={20} height={20} fill={colors.text} />)).padding(
                'top',
                '2xs',
              ),
              VStack(
                tip.title
                  ? RawText(tip.title).foreground('foreground').font('md').weight('semibold')
                  : null,
                RawText(tip.body)
                  .foreground(tip.title ? 'muted' : 'foreground')
                  .font(tip.title ? '14' : 'md')
                  .leading('20px'),
              )
                .flex('1')
                .spacing('2xs'),
            ).spacing('md'),
            tip.body,
          ),
        ),
      ),
    ).spacing('xl'),
  );
}
