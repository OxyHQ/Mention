import { memo } from 'react';
import { useRouter } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import { RiArrowRightLine } from '@oxy.so/bloom/icons/RiArrowRightLine';
import { useTheme } from '@oxy.so/bloom/theme';
import type { RemoteProfileMove } from '@mention/shared-types/profile';
import { profileBasePath } from './profileRoute';
import { HStack, Icon, RawText, VStack, toElement } from '@oxy.so/bloom-language';

interface ProfileMovedNoticeProps {
  movedTo: RemoteProfileMove;
}

/**
 * "This account has moved to @new@server" on a federated profile whose owner
 * announced a verified `Move` to another server — the notice Mastodon shows on a
 * moved account. Tapping it opens the new account's profile here.
 */
export const ProfileMovedNotice = memo(function ProfileMovedNotice({
  movedTo,
}: ProfileMovedNoticeProps) {
  const router = useRouter();
  const theme = useTheme();
  const { t } = useTranslation();
  const label = t('profile.movedTo', {
    handle: movedTo.handle,
    defaultValue: 'This account has moved to @{{handle}}',
  });

  return toElement(
    HStack(
      VStack(
        RawText(label)
          .foreground('foreground')
          .font('14')
          .leading('20px')
          .weight('medium')
          .lines(2),
      ).flex('1'),
      Icon(RiArrowRightLine).size('sm').foreground('muted'),
    )
      .padding('horizontal', 'md')
      .padding('vertical', 'sm')
      .background('mutedFill')
      .corner('md')
      .align('center')
      .spacing('sm')
      .margin('top', 'xs')
      .margin('bottom', 'sm')
      .role('link')
      .label(label)
      .onPress(() => router.push(profileBasePath('person', movedTo.handle))),
  );
});
