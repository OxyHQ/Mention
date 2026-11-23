import React from 'react';
import { RiAlertLine } from '@oxy.so/bloom/icons/RiAlertLine';
import { useTranslation } from 'react-i18next';

import { HStack, Icon, RawText, VStack, toElement } from '@oxy.so/bloom-language';

interface Props {
  /** The content-warning summary carried on the post (e.g. Mastodon `summary`). */
  text: string;
  /** Whether the reader has chosen to see what the warning covers. */
  revealed: boolean;
  onToggle: () => void;
}

/**
 * A post's content warning, as a GATE rather than a label.
 *
 * Federated posts (Mastodon and friends) carry a content warning as
 * `metadata.spoilerText`. The warning exists so a reader decides BEFORE seeing
 * the post, so while it is closed the post shows this block instead of its body
 * and every block below it (media, links, the quoted post) — `PostItem` owns
 * that and passes `revealed`. Once opened it shrinks to one line that can close
 * it again.
 *
 * It is the author's warning, not a moderation or community verdict, and says
 * so only through its label: it is styled as part of the post, never as a
 * system notice.
 */
const ContentWarning: React.FC<Props> = ({ text, revealed, onToggle }) => {
  const { t } = useTranslation();
  const label = t('post.contentWarning', { defaultValue: 'Content warning' });
  const show = t('post.contentWarningShow', { defaultValue: 'Show' });
  const hide = t('post.contentWarningHide', { defaultValue: 'Hide' });

  if (revealed) {
    return toElement(
      HStack(
        Icon(RiAlertLine).size('13').foreground('muted'),
        RawText(text ? `${label} · ${text}` : label)
          .foreground('muted')
          .shrink('normal')
          .font('sm')
          .lines(1),
        VStack(RawText(hide).foreground('primary').font('sm').weight('semibold'))
          .onPress(onToggle)
          .hitSlop('md')
          .role('button')
          .label(hide),
      )
        .margin('bottom', '6')
        .align('center')
        .spacing('6'),
    );
  }

  return toElement(
    HStack(
      VStack(Icon(RiAlertLine).size('18').foreground('muted'))
        .frame({ width: '36', height: '36' })
        .background('background')
        .corner('infinite')
        .align('center')
        .justify('center'),
      VStack(
        RawText(label)
          .foreground('muted')
          .font('xs')
          .weight('semibold')
          .textCase('uppercase')
          .tracking('wide'),
        text ? RawText(text).foreground('foreground').font('md').weight('semibold').lines(3) : null,
      )
        .flex('1')
        .shrink('normal')
        .spacing('2xs'),
      VStack(RawText(show).foreground('onPrimary').font('sm').weight('semibold'))
        .padding('horizontal', '14')
        .padding('vertical', '6')
        .background('primary')
        .corner('infinite'),
    )
      .padding('horizontal', 'md')
      .padding('vertical', 'md')
      .background('mutedFill')
      .border('border', 'thin')
      .corner('lg')
      .margin('top', '2xs')
      .align('center')
      .spacing('md')
      .when('pressed', (v) => v.opacity('80'))
      .onPress(onToggle)
      .role('button')
      .label(text ? `${label}: ${text}. ${show}` : `${label}. ${show}`),
  );
};

export default React.memo(ContentWarning);
