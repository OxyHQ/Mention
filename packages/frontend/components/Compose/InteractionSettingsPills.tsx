import { memo } from 'react';
import { RiAlertFill } from '@oxy.so/bloom/icons/RiAlertFill';
import { RiAlertLine } from '@oxy.so/bloom/icons/RiAlertLine';
import { RiEarthLine } from '@oxy.so/bloom/icons/RiEarthLine';
import { RiGroupLine } from '@oxy.so/bloom/icons/RiGroupLine';
import { useTranslation } from 'react-i18next';
import { ReplySettingsMenu } from './ReplySettingsMenu';
import type { ReplyPermission } from './replyPermission';

import { HStack, Icon, RawText, toElement } from '@oxy.so/bloom-language';

interface InteractionSettingsPillsProps {
  replyPermission: ReplyPermission[];
  quotesDisabled: boolean;
  isSensitive: boolean;
  onReplyPermissionChange: (permissions: ReplyPermission[]) => void;
  onQuotesDisabledChange: (disabled: boolean) => void;
  onSensitiveToggle: () => void;
}

const InteractionSettingsPills = memo<InteractionSettingsPillsProps>(
  ({
    replyPermission,
    quotesDisabled,
    isSensitive,
    onReplyPermissionChange,
    onQuotesDisabledChange,
    onSensitiveToggle,
  }) => {
    const { t } = useTranslation();

    const anyoneCanInteract = replyPermission.includes('anyone') && !quotesDisabled;
    const AudienceIcon = anyoneCanInteract ? RiEarthLine : RiGroupLine;
    const SensitiveIcon = isSensitive ? RiAlertFill : RiAlertLine;

    const sensitiveTone = isSensitive ? 'error' : 'muted';

    return toElement(
      HStack(
        ReplySettingsMenu(
          HStack(
            Icon(AudienceIcon).size('14').foreground('muted'),
            RawText(
              anyoneCanInteract
                ? t('compose.replySettings.anyoneCanInteract')
                : t('compose.replySettings.limited'),
            )
              .lines(1)
              .font('xs')
              .weight('medium')
              .foreground('muted'),
          )
            .align('center')
            .spacing('xs')
            .padding('horizontal', 'sm')
            .padding('vertical', 'xs')
            .background('surface')
            .corner('md')
            .pressFade('70'),
          { replyPermission, onReplyPermissionChange, quotesDisabled, onQuotesDisabledChange, t },
        ),
        HStack(
          Icon(SensitiveIcon).size('14').foreground(sensitiveTone),
          RawText(
            isSensitive ? t('compose.sensitive.on', 'CW: On') : t('compose.sensitive.off', 'CW'),
          )
            .font('xs')
            .weight('medium')
            .foreground(sensitiveTone),
        )
          .align('center')
          .spacing('xs')
          .padding('horizontal', 'sm')
          .padding('vertical', 'xs')
          .corner('md')
          .onPress(onSensitiveToggle)
          .pressFade('70'),
      )
        .padding('vertical', 'xs')
        .align('center')
        .spacing('sm'),
    );
  },
);

InteractionSettingsPills.displayName = 'InteractionSettingsPills';

export default InteractionSettingsPills;
