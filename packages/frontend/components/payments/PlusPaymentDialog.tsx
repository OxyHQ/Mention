import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, View } from 'react-native';
import { Dialog } from '@oxy.so/bloom/dialog';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';
import { parseContract, personalPlanCheckoutRequestCheck } from '@oxy.so/contracts/client';
import { authenticatedApiCall } from '@oxy.so/core';
import { useAuth, useOxy } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';
import { usePlusOffer } from '@/hooks/usePlusOffer';
import { useQueryClient } from '@tanstack/react-query';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import * as WebBrowser from 'expo-web-browser';
import { checkoutUrl } from '@/lib/payments/plusCheckout';
import { clearPlusCheckoutKey, getPlusCheckoutKey } from '@/lib/payments/plusCheckoutStorage';

type Message =
  | 'loading'
  | 'unavailable'
  | 'failed'
  | 'pending'
  | 'fulfilled'
  | 'closed'
  | 'review'
  | 'blocked'
  | null;

/** A new account/session gets a fresh dialog and cannot consume an earlier reply. */
export function PlusPaymentDialog({ onClose }: { onClose(): void }) {
  const { user } = useAuth();
  const { activeSessionId } = useOxy();
  return <PaymentContent key={`${user?.id}:${activeSessionId}`} onClose={onClose} />;
}

function PaymentContent({ onClose }: { onClose(): void }) {
  const { user, oxyServices, canUsePrivateApi, signIn } = useAuth();
  const { activeSessionId } = useOxy();
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { offer, loading, failed } = usePlusOffer();
  const [message, setMessage] = useState<Message>('loading');
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const scope = useRef({ active: false });
  const locked = useRef(false);
  const popup = useRef<Window | null>(null);
  const ownsNativeBrowser = useRef(false);
  useLayoutEffect(() => {
    const current = { active: canUsePrivateApi };
    scope.current = current;
    locked.current = false;
    setBusy(false);
    return () => {
      current.active = false;
      popup.current?.close();
      if (ownsNativeBrowser.current) WebBrowser.dismissBrowser();
    };
  }, [canUsePrivateApi]);
  useEffect(() => {
    if (!started)
      setMessage(loading ? 'loading' : failed ? 'failed' : offer ? null : 'unavailable');
  }, [offer, loading, failed, started]);

  async function purchase(openWindow: boolean) {
    if (!offer || !user?.id || !canUsePrivateApi || locked.current) return;
    const attemptScope = scope.current;
    const isCurrent = () => attemptScope.active && scope.current === attemptScope;
    if (!isCurrent()) return;
    locked.current = true;
    setStarted(true);
    setBusy(true);
    // Reserve the browser window in the click gesture, before network awaits.
    if (openWindow) popup.current?.close();
    const windowForAttempt =
      openWindow && Platform.OS === 'web'
        ? window.open('about:blank', '_blank', 'popup,width=480,height=720')
        : null;
    if (windowForAttempt) windowForAttempt.opener = null;
    if (openWindow) popup.current = windowForAttempt;
    try {
      const key = await getPlusCheckoutKey(user.id, offer);
      if (!isCurrent()) return;
      const result = await authenticatedApiCall(oxyServices, activeSessionId, () => {
        if (!isCurrent()) throw new Error('Account changed');
        return oxyServices.billing.startPersonalPlanCheckout(
          parseContract(personalPlanCheckoutRequestCheck, {
            expectedSubjectAccountId: user.id,
            offerId: offer.offerId,
            offerVersion: offer.offerVersion,
            idempotencyKey: key,
          }),
        );
      });
      if (!isCurrent()) return;
      if (result.state === 'pending') {
        setMessage('pending');
        if (openWindow && result.checkoutUrl) {
          const url = checkoutUrl(result.checkoutUrl);
          if (Platform.OS === 'web') {
            if (!windowForAttempt || windowForAttempt.closed) setMessage('blocked');
            else windowForAttempt.location.replace(url);
          } else {
            ownsNativeBrowser.current = true;
            try {
              await WebBrowser.openBrowserAsync(url);
            } finally {
              ownsNativeBrowser.current = false;
            }
          }
        } else windowForAttempt?.close();
      } else {
        windowForAttempt?.close();
        setMessage(result.state === 'unconfigured' ? 'unavailable' : result.state);
        if (result.state === 'closed' || result.state === 'fulfilled') {
          await clearPlusCheckoutKey(user.id, offer, key).catch(() => undefined);
          // Only authoritative Oxy user reads can update access elsewhere in Mention.
          if (isCurrent() && result.state === 'fulfilled') {
            popup.current?.close();
            await queryClient
              .invalidateQueries({
                queryKey: viewerQueryKeys.mentionPersonalization(
                  user.id,
                  activeSessionId,
                  canUsePrivateApi,
                ),
              })
              .catch(() => undefined);
          }
        }
      }
    } catch (error) {
      windowForAttempt?.close();
      if (isCurrent())
        setMessage(
          error instanceof Error &&
            (error.message === 'PAYMENT_REVIEW_REQUIRED' ||
              ('code' in error && error.code === 'PAYMENT_REVIEW_REQUIRED'))
            ? 'review'
            : 'failed',
        );
    } finally {
      if (isCurrent()) {
        locked.current = false;
        setBusy(false);
      }
    }
  }
  const done = message === 'fulfilled' || message === 'closed' || message === 'review';
  return (
    <Dialog open onClose={onClose} title={t('plus.payment.title')} label={t('plus.payment.title')}>
      <View className="gap-4 p-5">
        <Text>{t('plus.payment.description')}</Text>
        {offer?.price && (
          <>
            <Text>{offer.displayName}</Text>
            <Text>
              {t('plus.payment.monthlyPrice', {
                price: new Intl.NumberFormat(i18n.language, {
                  style: 'currency',
                  currency: offer.price.currency,
                }).format(offer.price.amountMinorUnits / 100),
              })}
            </Text>
            {offer.benefits.map(({ displayName, benefit }) => (
              <Text key={`${benefit.productId}:${benefit.kind}:${benefit.key}`}>{displayName}</Text>
            ))}
          </>
        )}
        {(busy || message === 'loading') && (
          <ActivityIndicator accessibilityLabel={t('common.loading')} />
        )}
        {message && <Text accessibilityLiveRegion="polite">{t(`plus.payment.${message}`)}</Text>}
        {!canUsePrivateApi && (
          <Button
            onPress={() => {
              void signIn();
            }}
          >
            {t('plus.payment.signIn')}
          </Button>
        )}
        {offer && !done && (
          <Button
            disabled={busy}
            onPress={() => {
              void purchase(true);
            }}
          >
            {t('plus.payment.continue')}
          </Button>
        )}
        {offer && started && !done && (
          <Button
            disabled={busy}
            onPress={() => {
              void purchase(false);
            }}
          >
            {t('plus.payment.checkStatus')}
          </Button>
        )}
        <Button onPress={onClose}>{t('common.close')}</Button>
      </View>
    </Dialog>
  );
}
