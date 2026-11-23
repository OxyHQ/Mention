import { memo, useMemo } from 'react';
import { TouchableOpacity, StyleSheet } from 'react-native';
import { RiAlertFill } from '@oxy.so/bloom/icons/RiAlertFill';
import { RiAlertLine } from '@oxy.so/bloom/icons/RiAlertLine';
import { RiEarthLine } from '@oxy.so/bloom/icons/RiEarthLine';
import { RiGroupLine } from '@oxy.so/bloom/icons/RiGroupLine';
import { useColorTokens } from '@oxy.so/bloom/theme';
import { useTranslation } from 'react-i18next';
import { ReplySettingsMenu } from './ReplySettingsMenu';
import type { ReplyPermission } from './replyPermission';

import { Embed, HStack, Icon, RawText, toElement } from '@oxy.so/bloom-language';

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
    const colorTokens = useColorTokens();
    const { t } = useTranslation();

    const anyoneCanInteract = replyPermission.includes('anyone') && !quotesDisabled;
    const AudienceIcon = anyoneCanInteract ? RiEarthLine : RiGroupLine;
    const SensitiveIcon = isSensitive ? RiAlertFill : RiAlertLine;

    const replyPillStyle = useMemo(
      () => [styles.pill, { backgroundColor: colorTokens.surface }],
      [colorTokens.surface],
    );
    const sensitiveTone = isSensitive ? 'error' : 'muted';

    return toElement(
      HStack(
        Embed(
          <ReplySettingsMenu
            replyPermission={replyPermission}
            onReplyPermissionChange={onReplyPermissionChange}
            quotesDisabled={quotesDisabled}
            onQuotesDisabledChange={onQuotesDisabledChange}
          >
            <TouchableOpacity activeOpacity={0.7} style={replyPillStyle}>
              {toElement(Icon(AudienceIcon).size('14').foreground('muted'))}
              {toElement(
                RawText(
                  anyoneCanInteract
                    ? t('compose.replySettings.anyoneCanInteract')
                    : t('compose.replySettings.limited'),
                )
                  .lines(1)
                  .font('xs')
                  .weight('medium')
                  .foreground('muted'),
              )}
            </TouchableOpacity>
          </ReplySettingsMenu>,
        ),
        Embed(
          <TouchableOpacity onPress={onSensitiveToggle} activeOpacity={0.7} style={styles.pill}>
            {toElement(Icon(SensitiveIcon).size('14').foreground(sensitiveTone))}
            {toElement(
              RawText(
                isSensitive
                  ? t('compose.sensitive.on', 'CW: On')
                  : t('compose.sensitive.off', 'CW'),
              )
                .font('xs')
                .weight('medium')
                .foreground(sensitiveTone),
            )}
          </TouchableOpacity>,
        ),
      )
        .padding('vertical', 'xs')
        .align('center')
        .spacing('sm'),
    );
  },
);

InteractionSettingsPills.displayName = 'InteractionSettingsPills';

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 4,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
  },
});

export default InteractionSettingsPills;
