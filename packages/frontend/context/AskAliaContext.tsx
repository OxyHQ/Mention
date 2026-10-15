import type React from 'react';
import { Suspense, createContext, lazy, useCallback, useContext, useMemo, useState } from 'react';
import { usePathname } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxy.so/services/ui/client';

const AskAliaSheet = lazy(() => import('@/components/AskAliaSheet'));

interface AskAliaContextType {
  /**
   * Open the Alia chat sheet. Signed out, the sheet is not mounted (it could
   * not call Alia), so this opens the Oxy sign-in dialog instead.
   */
  open: () => void;
}

const AskAliaContext = createContext<AskAliaContextType | undefined>(undefined);

export function useAskAlia(): AskAliaContextType {
  const context = useContext(AskAliaContext);
  if (!context) throw new Error('useAskAlia must be used within an AskAliaProvider');
  return context;
}

/**
 * Owns the one `AliaChatSheet` and the way to open it. The sheet is mounted
 * here, once, at the app root rather than beside the sidebar row (a drawer
 * unmounts when it closes), and only after the first press so the Alia SDK
 * stays out of the entry bundle. The SDK greets and loads the 3D avatar from
 * alia.onl itself.
 *
 * Must sit inside `OxyProvider` (auth), the portal provider and the router.
 */
export const AskAliaProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { t } = useTranslation();
  const pathname = usePathname() || '/';
  const { canUsePrivateApi, signIn } = useAuth();
  const [presentSignal, setPresentSignal] = useState(0);

  const welcomeSuggestions = useMemo(
    () => [
      { id: 'news', text: t('alia.suggestion.news') },
      { id: 'write', text: t('alia.suggestion.write') },
      { id: 'discover', text: t('alia.suggestion.discover') },
    ],
    [t],
  );

  const clientContext = `${t('alia.clientContext')} ${t('alia.onScreen', { path: pathname })}`;

  const open = useCallback(() => {
    if (canUsePrivateApi) setPresentSignal((signal) => signal + 1);
    else signIn().catch(() => {});
  }, [canUsePrivateApi, signIn]);

  const value = useMemo<AskAliaContextType>(() => ({ open }), [open]);

  return (
    <AskAliaContext.Provider value={value}>
      {children}
      {canUsePrivateApi && presentSignal > 0 && (
        <Suspense fallback={null}>
          <AskAliaSheet
            presentSignal={presentSignal}
            clientContext={clientContext}
            welcomeSuggestions={welcomeSuggestions}
          />
        </Suspense>
      )}
    </AskAliaContext.Provider>
  );
};
