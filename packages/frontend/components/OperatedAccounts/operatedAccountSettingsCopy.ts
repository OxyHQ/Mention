import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { MAX_ACCOUNT_CATEGORIES } from '@oxy.so/contracts';

/** The member-operated account kinds (`isMemberOperatedKind`) Mention manages. */
export type OperatedAccountKind = 'channel' | 'community';

/**
 * The words the settings screen speaks in for ONE kind. Everything the two kinds
 * say identically (save, categories, the delete group's title) is written once at
 * its call site under `operatedAccounts.settings.*`; only what names the kind is
 * here.
 */
export interface OperatedAccountSettingsCopy {
  title: string;
  signInRequired: string;
  signInRequiredDesc: string;
  operatorOnly: string;
  profile: string;
  nameLabel: string;
  bioPlaceholder: string;
  bioLabel: string;
  profileSaved: string;
  profileSaveFailed: string;
  categoriesFooter: string;
  deleteRow: string;
  deleteFooter: string;
  deleted: string;
  deleteFailed: string;
  identityFooter: string;
}

/**
 * Static keys per kind rather than a `${kind}` template, so every key stays
 * visible to `scripts/validate-i18n.mjs` and to a translator's search.
 */
export function useOperatedAccountSettingsCopy(
  kind: OperatedAccountKind,
): OperatedAccountSettingsCopy {
  const { t } = useTranslation();
  return useMemo(() => {
    const max = MAX_ACCOUNT_CATEGORIES;
    if (kind === 'channel') {
      return {
        title: t('channels.settings.title'),
        signInRequired: t('channels.signInRequired'),
        signInRequiredDesc: t('channels.signInRequiredDesc'),
        operatorOnly: t('channels.settings.operatorOnly'),
        profile: t('channels.settings.profile'),
        nameLabel: t('channels.titleLabel'),
        bioPlaceholder: t('channels.settings.bioPlaceholder'),
        bioLabel: t('channels.settings.bioLabel'),
        profileSaved: t('channels.settings.profileSaved'),
        profileSaveFailed: t('channels.settings.profileSaveFailed'),
        categoriesFooter: t('channels.settings.categoriesFooter', { max }),
        deleteRow: t('channels.settings.delete'),
        deleteFooter: t('channels.settings.deleteFooter'),
        deleted: t('channels.settings.deleted'),
        deleteFailed: t('channels.settings.deleteFailed'),
        identityFooter: t('channels.settings.identityFooter'),
      };
    }
    return {
      title: t('communities.settings.title'),
      signInRequired: t('communities.signInRequired'),
      signInRequiredDesc: t('communities.signInRequiredDesc'),
      operatorOnly: t('communities.settings.operatorOnly'),
      profile: t('communities.settings.profile'),
      nameLabel: t('communities.titleLabel'),
      bioPlaceholder: t('communities.settings.bioPlaceholder'),
      bioLabel: t('communities.settings.bioLabel'),
      profileSaved: t('communities.settings.profileSaved'),
      profileSaveFailed: t('communities.settings.profileSaveFailed'),
      categoriesFooter: t('communities.settings.categoriesFooter', { max }),
      deleteRow: t('communities.settings.delete'),
      deleteFooter: t('communities.settings.deleteFooter'),
      deleted: t('communities.settings.deleted'),
      deleteFailed: t('communities.settings.deleteFailed'),
      identityFooter: t('communities.settings.identityFooter'),
    };
  }, [kind, t]);
}
