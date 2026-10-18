import type React from 'react';
import { useMemo } from 'react';
import { usePathname } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { AliaAskProvider, type AliaAsk } from '@alia.onl/sdk/ask';

/**
 * Alia's one sheet for the whole app (`@alia.onl/sdk/ask`). Anything below opens it with
 * `useAskAgent().ask(undefined, turn?)`; signed out, the SDK opens the Oxy sign-in instead. The
 * sheet loads with the first ask, so the chat stays out of the entry bundle (`bundle-budgets.json`
 * holds that). Alia is told which screen the person is on, as the route names it, and the
 * conversations the sheet starts are labelled Mention's (`app`), so its recents are Mention's.
 *
 * Must sit inside `OxyProvider` (auth), the portal provider and the router, beside the inert
 * boundary rather than in it: the sheet portals into the outlet.
 */
export const MentionAskProvider: React.FC<{
  children: React.ReactNode;
  askRef?: React.Ref<AliaAsk>;
}> = ({ children, askRef }) => {
  const { t } = useTranslation();
  const pathname = usePathname() || '/';

  const welcomeSuggestions = useMemo(
    () => [
      { id: 'news', text: t('alia.suggestion.news') },
      { id: 'write', text: t('alia.suggestion.write') },
      { id: 'discover', text: t('alia.suggestion.discover') },
    ],
    [t],
  );

  return (
    <AliaAskProvider
      ref={askRef}
      app="mention"
      clientContext={`${t('alia.clientContext')} ${t('alia.onScreen', { path: pathname })}`}
      welcomeSuggestions={welcomeSuggestions}
    >
      {children}
    </AliaAskProvider>
  );
};
