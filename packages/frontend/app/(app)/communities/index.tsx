import { useTranslation } from 'react-i18next';
import { OperatedAccountsScreen } from '@/components/OperatedAccounts/OperatedAccountsScreen';

/**
 * The communities you moderate, and the one place to create another. A
 * community is an Oxy account people JOIN (follow) and post IN; its members are
 * its moderators, and Mention relays its posts to the fediverse as a Lemmy-style
 * `Group`. See `OperatedAccountsScreen` for what creating one is.
 */
export default function CommunitiesScreen() {
  const { t } = useTranslation();
  return (
    <OperatedAccountsScreen
      kind="community"
      copy={{
        title: t('communities.title', { defaultValue: 'Communities' }),
        signInRequired: t('communities.signInRequired', {
          defaultValue: 'Sign in to manage your communities',
        }),
        signInRequiredDesc: t('communities.signInRequiredDesc', {
          defaultValue:
            'A community is a forum: people join it and post in it, and you moderate it.',
        }),
        createTitle: t('communities.createTitle', { defaultValue: 'Create a community' }),
        createSubtitle: t('communities.createSubtitle', {
          defaultValue:
            'Anyone can join and post in it, here and from the fediverse. You and the moderators you invite keep it on topic.',
        }),
        handleLabel: t('communities.handleLabel', { defaultValue: 'Community handle' }),
        titleLabel: t('communities.titleLabel', { defaultValue: 'Community name' }),
        create: t('communities.create', { defaultValue: 'Create community' }),
        yours: t('communities.yours', { defaultValue: 'Communities you moderate' }),
        none: t('communities.none', { defaultValue: 'You do not moderate any community yet.' }),
        created: t('communities.created', { defaultValue: 'Community created' }),
        createFailed: t('communities.createFailed', {
          defaultValue: 'Failed to create the community',
        }),
      }}
    />
  );
}
