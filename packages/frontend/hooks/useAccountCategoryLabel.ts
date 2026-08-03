import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { AccountCategoryId } from '@oxyhq/contracts';

import { ACCOUNT_CATEGORY_ENGLISH_LABELS } from '@/utils/accountCategories';

/**
 * Names an account-category id in the READER's language.
 *
 * TOTAL over the vocabulary this build knows, and that is the whole reason the
 * "can this be named at all" question lives elsewhere — in
 * `isKnownAccountCategoryId`, `primaryAccountCategoryId` and
 * `nameableAccountCategoryIds`. An id the server sends and this build has never
 * heard of is not a labelling failure to paper over with a fallback string; it
 * is a decision each surface has to make for itself, and the profile, the about
 * screen and the picker all make it differently. Handing back a plausible
 * string for an unknown id would take that decision away from all three.
 *
 * The key is written as a literal template so the i18n validator records
 * `accounts.accountCategory.` as a reachable prefix — built from a variable, the
 * whole catalog would read as unreachable and the orphan check would demand its
 * deletion. The shape is the one the Oxy SDK's own `User.accountCategories`
 * docstring names, so a label shown here and one shown in the account manager
 * cannot drift apart.
 *
 * The English `defaultValue` is what keeps a missing catalog entry from
 * rendering the KEY at a reader — i18next echoes the key when it resolves
 * nothing, and `accounts.accountCategory.news` on a profile is worse than the
 * raw slug this indirection exists to avoid.
 */
export function useAccountCategoryLabel(): (id: AccountCategoryId) => string {
  const { t } = useTranslation();

  return useCallback(
    (id: AccountCategoryId): string =>
      t(`accounts.accountCategory.${id}`, {
        defaultValue: ACCOUNT_CATEGORY_ENGLISH_LABELS[id],
      }),
    [t],
  );
}
