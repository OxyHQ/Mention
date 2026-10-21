import type React from 'react';
import { Suspense, createContext, lazy, useCallback, useContext, useMemo, useState } from 'react';
import { usePathname } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxy.so/services/ui/client';

const AskAliaSheet = lazy(() => import('@/components/AskAliaSheet'));

/** What a screen asks Alia: a message sent as soon as the sheet opens, and what Alia should know. */
export interface AskAliaRequest {
  /** Sent as the person's first message; the conversation opens over the sheet. */
  prompt: string;
  /** Told to Alia with the message: what is on screen, which ids to look up. */
  context?: string;
}

interface AskAliaContextType {
  /**
   * Open the Alia chat sheet, with a message already sent when `request` is given (a profile's
   * "ask Alia about this", as X does with Grok). Signed out, the sheet is not mounted (it could
   * not call Alia), so this opens the Oxy sign-in dialog instead.
   */
  open: (request?: AskAliaRequest) => void;
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
  const [ask, setAsk] = useState<{ id: number; request?: AskAliaRequest }>({ id: 0 });

  const welcomeSuggestions = useMemo(
    () => [
      { id: 'news', text: t('alia.suggestion.news') },
      { id: 'write', text: t('alia.suggestion.write') },
      { id: 'discover', text: t('alia.suggestion.discover') },
    ],
    [t],
  );

  const clientContext = [
    t('alia.clientContext'),
    t('alia.onScreen', { path: pathname }),
    ask.request?.context,
  ]
    .filter(Boolean)
    .join(' ');

  const open = useCallback(
    (request?: AskAliaRequest) => {
      if (canUsePrivateApi) setAsk((current) => ({ id: current.id + 1, request }));
      else signIn().catch(() => {});
    },
    [canUsePrivateApi, signIn],
  );

  const value = useMemo<AskAliaContextType>(() => ({ open }), [open]);

  return (
    <AskAliaContext.Provider value={value}>
      {children}
      {canUsePrivateApi && ask.id > 0 && (
        <Suspense fallback={null}>
          <AskAliaSheet
            askId={ask.id}
            prompt={ask.request?.prompt}
            clientContext={clientContext}
            welcomeSuggestions={welcomeSuggestions}
          />
        </Suspense>
      )}
    </AskAliaContext.Provider>
  );
};
