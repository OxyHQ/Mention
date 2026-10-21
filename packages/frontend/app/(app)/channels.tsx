import { useTranslation } from 'react-i18next';
import { OperatedAccountsScreen } from '@/components/OperatedAccounts/OperatedAccountsScreen';

/**
 * The channels you operate, and the one place to create another. A channel is
 * an Oxy account people follow without following the people who write for it;
 * see `OperatedAccountsScreen` for what creating one is.
 */
export default function ChannelsScreen() {
  const { t } = useTranslation();
  return (
    <OperatedAccountsScreen
      kind="channel"
      copy={{
        title: t('channels.title', { defaultValue: 'Channels' }),
        signInRequired: t('channels.signInRequired', {
          defaultValue: 'Sign in to manage your channels',
        }),
        signInRequiredDesc: t('channels.signInRequiredDesc', {
          defaultValue:
            'A channel is an account people follow without following the people who write for it.',
        }),
        createTitle: t('channels.createTitle', { defaultValue: 'Create a channel' }),
        createSubtitle: t('channels.createSubtitle', {
          defaultValue:
            'A channel posts under its own name. People follow it without following you.',
        }),
        handleLabel: t('channels.handleLabel', { defaultValue: 'Channel handle' }),
        titleLabel: t('channels.titleLabel', { defaultValue: 'Channel name' }),
        create: t('channels.create', { defaultValue: 'Create channel' }),
        yours: t('channels.yours', { defaultValue: 'Your channels' }),
        none: t('channels.none', { defaultValue: 'You do not operate any channel yet.' }),
        created: t('channels.created', { defaultValue: 'Channel created' }),
        createFailed: t('channels.createFailed', { defaultValue: 'Failed to create the channel' }),
      }}
    />
  );
}
