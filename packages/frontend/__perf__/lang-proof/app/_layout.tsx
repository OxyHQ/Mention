/**
 * DEV ONLY: the root of the Bloom language proof app (`../README.md`), exported
 * with `BLOOM_LANG_PROOF=1` in place of Mention's own `app/`. It keeps what the
 * screen draws through (Mention's stylesheet, Bloom's provider with Mention's
 * colour preset and fonts, the app's i18n) and nothing else: no auth, no
 * network, no shell.
 */
import 'react-native-reanimated';
import { useEffect, useState } from 'react';
import { Slot } from 'expo-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { BloomProvider } from '@oxy.so/bloom/provider';
import { BloomNativeWindTheme } from '@oxy.so/app-preset/nativewind-theme';

import { APP_DEFAULT_COLOR_PRESET } from '@/lib/colorEntitlement';
import i18n, { initializeI18n } from '@/lib/i18n';

import '../../../global.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

export default function ProofLayout() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void initializeI18n('en').then(() => setReady(true));
  }, []);
  if (!ready) return null;
  return (
    <BloomProvider locale="en" defaultMode="light" defaultColorPreset={APP_DEFAULT_COLOR_PRESET}>
      <BloomNativeWindTheme>
        <QueryClientProvider client={queryClient}>
          <I18nextProvider i18n={i18n}>
            <Slot />
          </I18nextProvider>
        </QueryClientProvider>
      </BloomNativeWindTheme>
    </BloomProvider>
  );
}
