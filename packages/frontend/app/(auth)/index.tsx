import { useAuth } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';

import { LogoIcon } from '@/assets/logo';
import { useWindowBreakpoint } from '@oxy.so/bloom/hooks';
import { useTheme } from '@oxy.so/bloom/theme';
import {
  Embed,
  RawText,
  VStack,
  toElement,
  Button as LButton,
  Text as LText,
} from '@oxy.so/bloom-language';

export default function AuthScreen() {
  const { signIn } = useAuth();
  const { t } = useTranslation();
  const { colors } = useTheme();
  const breakpoint = useWindowBreakpoint();
  const wide = breakpoint !== 'base' && breakpoint !== 'sm';

  // Both layouts render always; the `md` breakpoint (768px) toggles which is
  // displayed: the desktop split-screen at >=md, the stacked mobile layout
  // below it. The window's breakpoint tier is Bloom's own (re-rendering only
  // when the window crosses one); the mobile layout's padding adds the safe
  // area's insets to its own.
  const signInButton = LButton(LText(t('auth.signIn.withOxy')))
    .style('solid')
    .tint('accent')
    .size('lg')
    .onPress(() => signIn().catch(() => {}))
    .frame({ width: 'full' });
  return (
    <>
      {/* Desktop split-screen (>= md) */}
      {toElement(
        VStack(
          VStack(
            VStack(
              Embed(<LogoIcon size={56} color="#fff" />),
              // The wordmarks' sizes (42px, 28px) are numeric font tokens.
              RawText('Mention').font('42').weight('bold').foreground('white').margin('top', 'sm'),
              RawText(t('auth.signIn.subtitle')).font('xl').leading('28px').foreground('white/85'),
            )
              .frame({ maxWidth: '400' })
              .align('start')
              .spacing('lg'),
          )
            .padding('all', '48')
            .background('primary')
            .flex('1')
            .justify('center')
            .align('center'),
          VStack(
            VStack(
              RawText(t('auth.signIn.title'))
                .font('24')
                .leading('32px')
                .weight('bold')
                .foreground('foreground'),
              signInButton,
            )
              .frame({ width: 'full', maxWidth: '360' })
              .spacing('2xl'),
          )
            .padding('all', '48')
            .flex('1')
            .justify('center')
            .align('center'),
        )
          .flex('1')
          // A row only where it is shown: hidden, the split has no axis of its own.
          .hidden()
          .when(wide, (v) => v.axis('horizontal').hidden(false)),
      )}
      {/* Stacked mobile layout (< md) */}
      {toElement(
        VStack(
          VStack(
            Embed(<LogoIcon size={48} color={colors.primary} />),
            RawText('Mention')
              .font('28')
              .weight('bold')
              .foreground('foreground')
              .margin('top', 'sm'),
            RawText(t('auth.signIn.subtitle'))
              .frame({ maxWidth: '280' })
              .font('16')
              .textAlign('center')
              .leading('22px')
              .foreground('muted'),
          )
            .flex('1')
            .justify('center')
            .align('center')
            .spacing('lg'),
          VStack(signInButton).padding('bottom', '3xl').frame({ width: 'full', maxWidth: '320' }),
        )
          .flex('1')
          .justify('center')
          .align('center')
          .padding('horizontal', '2xl')
          .safeAreaPadding('vertical')
          .padding('vertical', '2xl')
          .hidden(wide),
      )}
    </>
  );
}
