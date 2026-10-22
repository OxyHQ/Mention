import { useCallback, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import {
  accountCategoryLabel,
  getLocalesVersion,
  subscribeLocales,
  type AccountCategoryId,
} from '@oxy.so/core';

/**
 * Names an account-category id in the READER's language, with Oxy's own
 * vocabulary (`accountCategoryLabel` in `@oxy.so/core`) — the same words the
 * account settings and every other Oxy app use, in every language Mention
 * ships. Mention keeps no copy of the labels.
 *
 * TOTAL over the vocabulary this build knows, and that is the whole reason the
 * "can this be named at all" question lives elsewhere — in
 * `isKnownAccountCategoryId`, `primaryAccountCategoryId` and
 * `nameableAccountCategoryIds`. An id the server sends and this build has never
 * heard of is a decision each surface makes for itself.
 *
 * Core loads a non-English dictionary on demand and serves English until it
 * lands; the version subscription re-renders the label when it does.
 */
export function useAccountCategoryLabel(): (id: AccountCategoryId) => string {
  const { i18n } = useTranslation();
  const language = i18n.language;
  const localesVersion = useSyncExternalStore(
    subscribeLocales,
    getLocalesVersion,
    getLocalesVersion,
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `localesVersion` is the re-translate signal — a new function once a dictionary lands.
  return useCallback(
    (id: AccountCategoryId): string => accountCategoryLabel(language, id),
    [language, localesVersion],
  );
}
