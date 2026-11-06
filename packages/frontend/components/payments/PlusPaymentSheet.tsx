import type { EmbeddedCheckoutBinding } from '@/lib/payments/embeddedCheckout';
import { PeableEmbeddedCheckout } from './PeableEmbeddedCheckout';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, View } from 'react-native';
import { BottomSheet } from '@oxy.so/bloom/bottom-sheet';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';
import {
  parseContract,
  productPlanCheckoutRequestCheck,
  subjectProductAccessQueryCheck,
} from '@oxy.so/contracts/client';
import { authenticatedApiCall } from '@oxy.so/core';
import { useAuth, useOxy } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';
import { usePlusOffer } from '@/hooks/usePlusOffer';
import { useQueryClient } from '@tanstack/react-query';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import * as WebBrowser from 'expo-web-browser';
import {
  checkoutUrl,
  includesPlus,
  plusPriceMajorUnits,
  type PlusCadence,
  type PlusOffer,
  type PlusOfferBinding,
} from '@/lib/payments/plusCheckout';
import { PlusDisplayEstimate } from './PlusDisplayEstimate';
import { PlusSessionCheckout, type OpenHostedCheckout } from './PlusSessionCheckout';
import {
  hostedSessionCapability,
  type PlusSessionCapability,
} from '@/lib/payments/plusSessionCheckout';
import { clearPlusCheckoutKey, getPlusCheckoutKey } from '@/lib/payments/plusCheckoutStorage';

type Message =
  | 'loading'
  | 'unavailable'
  | 'notReady'
  | 'failed'
  | 'pending'
  | 'fulfilled'
  | 'closed'
  | 'review'
  | 'blocked'
  | 'included'
  | 'signInRequired'
  | null;

/** A new account/session gets a fresh dialog and cannot consume an earlier reply. */
export function PlusPaymentSheet({
  onClose,
  cadence = 'month',
  embeddedBinding,
}: {
  onClose(): void;
  cadence?: PlusCadence;
  embeddedBinding?: EmbeddedCheckoutBinding;
}) {
  const { user } = useAuth();
  const { activeSessionId } = useOxy();
  if (embeddedBinding)
    return (
      <PeableEmbeddedCheckout
        key={embeddedBinding.intentId}
        binding={embeddedBinding}
        onClose={onClose}
      />
    );
  return (
    <PaymentContent
      key={`${user?.id}:${activeSessionId}:${cadence}`}
      onClose={onClose}
      cadence={cadence}
    />
  );
}

function PaymentContent({ onClose, cadence }: { onClose(): void; cadence: PlusCadence }) {
  const { user, oxyServices, canUsePrivateApi, signIn } = useAuth();
  const { activeSessionId } = useOxy();
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const {
    offer: currentOffer,
    binding: currentBinding,
    loading,
    failed,
    hasAccess,
    checkingAccess,
    accessFailed,
    purchaseAvailable,
  } = usePlusOffer(cadence);
  // Hold the reviewed commercial terms through pending/recovery; a refetch must
  // not relabel an operation already sent with a different price or offer.
  const [operation, setOperation] = useState<{
    offer: PlusOffer;
    binding: PlusOfferBinding;
  } | null>(null);
  const offer = operation?.offer ?? currentOffer;
  const mentionPlusBinding = operation?.binding ?? currentBinding;
  const [message, setMessage] = useState<Message>('loading');
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const [hasOperation, setHasOperation] = useState(false);
  // The pending Peable order, driven in Mention's own sheet while it can be read.
  const [sessionCheckout, setSessionCheckout] = useState<{
    capability: PlusSessionCapability;
    url: string;
  } | null>(null);
  // A pending checkout Mention cannot drive itself: opened only from a press.
  const [hostedUrl, setHostedUrl] = useState<string | null>(null);
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
      setMessage(
        hasAccess
          ? 'included'
          : loading || checkingAccess
            ? 'loading'
            : failed || accessFailed
              ? 'failed'
              : !offer
                ? 'unavailable'
                : !purchaseAvailable
                  ? 'notReady'
                  : !canUsePrivateApi
                    ? 'signInRequired'
                    : null,
      );
  }, [
    offer,
    loading,
    failed,
    started,
    canUsePrivateApi,
    hasAccess,
    checkingAccess,
    accessFailed,
    purchaseAvailable,
  ]);

  async function purchase(startCheckout: boolean) {
    if (
      !offer ||
      !mentionPlusBinding ||
      !user?.id ||
      !canUsePrivateApi ||
      (startCheckout && (!purchaseAvailable || hasAccess || checkingAccess || accessFailed)) ||
      (!startCheckout && !hasOperation) ||
      locked.current
    )
      return;
    const attemptScope = scope.current;
    const isCurrent = () => attemptScope.active && scope.current === attemptScope;
    if (!isCurrent()) return;
    locked.current = true;
    setOperation({ offer, binding: mentionPlusBinding });
    setStarted(true);
    setBusy(true);
    try {
      if (startCheckout) {
        const access = await authenticatedApiCall(oxyServices, activeSessionId, () => {
          if (!isCurrent()) throw new Error('Account changed');
          return oxyServices.billing.productAccess(
            parseContract(subjectProductAccessQueryCheck, {
              schemaVersion: 1,
              subjectAccountId: user.id,
              productId: offer.productId,
            }),
          );
        });
        if (!isCurrent()) return;
        if (includesPlus(access, user.id, mentionPlusBinding)) {
          setMessage('included');
          return;
        }
      }
      const key = await getPlusCheckoutKey(user.id, mentionPlusBinding);
      if (!isCurrent()) return;
      setHasOperation(true);
      const result = await authenticatedApiCall(oxyServices, activeSessionId, () => {
        if (!isCurrent()) throw new Error('Account changed');
        return oxyServices.billing.startProductPlanCheckout(
          parseContract(productPlanCheckoutRequestCheck, {
            expectedSubjectAccountId: user.id,
            productId: offer.productId,
            offerId: offer.offerId,
            offerVersion: offer.offerVersion,
            idempotencyKey: key,
          }),
        );
      });
      if (!isCurrent()) return;
      if (result.state === 'pending') {
        setMessage('pending');
        if (startCheckout && result.checkoutUrl) {
          const url = checkoutUrl(result.checkoutUrl);
          const capability = hostedSessionCapability(url);
          // Card and FairCoin are chosen in Mention's sheet over the same order;
          // anything Mention cannot drive stays a hosted page.
          if (capability) setSessionCheckout({ capability, url });
          else setHostedUrl(url);
        }
      } else {
        setSessionCheckout(null);
        setHostedUrl(null);
        setMessage(result.state === 'unconfigured' ? 'unavailable' : result.state);
        if (result.state === 'closed' || result.state === 'fulfilled') {
          await clearPlusCheckoutKey(user.id, mentionPlusBinding, key).catch(() => undefined);
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
            if (isCurrent())
              await queryClient
                .invalidateQueries({
                  queryKey: viewerQueryKeys.mentionPlusAccess(
                    user.id,
                    activeSessionId,
                    mentionPlusBinding.productId,
                    mentionPlusBinding.capabilityKey,
                  ),
                })
                .catch(() => undefined);
          }
        }
      }
    } catch (error) {
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
  /** The hosted page, from the press that asked for it: the web window is
   * reserved before any await, so a popup blocker sees the gesture. */
  const openHosted: OpenHostedCheckout = async (url, before) => {
    const attemptScope = scope.current;
    const isCurrent = () => attemptScope.active && scope.current === attemptScope;
    popup.current?.close();
    const windowForAttempt =
      Platform.OS === 'web'
        ? window.open('about:blank', '_blank', 'popup,width=480,height=720')
        : null;
    if (windowForAttempt) windowForAttempt.opener = null;
    popup.current = windowForAttempt;
    if (before && !(await before())) {
      windowForAttempt?.close();
      return;
    }
    if (!isCurrent()) {
      windowForAttempt?.close();
      return;
    }
    if (Platform.OS === 'web') {
      if (!windowForAttempt || windowForAttempt.closed) setMessage('blocked');
      else windowForAttempt.location.replace(url);
      return;
    }
    ownsNativeBrowser.current = true;
    try {
      await WebBrowser.openBrowserAsync(url);
    } finally {
      ownsNativeBrowser.current = false;
    }
  };
  const done =
    message === 'fulfilled' ||
    message === 'closed' ||
    message === 'review' ||
    message === 'included';
  if (sessionCheckout && offer && !done && canUsePrivateApi)
    return (
      <PlusSessionCheckout
        key={sessionCheckout.capability.sessionId}
        capability={sessionCheckout.capability}
        hostedUrl={sessionCheckout.url}
        offer={offer}
        openHosted={openHosted}
        onSettled={() => {
          // The gateway closed the order; only Oxy's answer can grant access.
          setSessionCheckout(null);
          void purchase(false);
        }}
        onUnavailable={() => {
          setHostedUrl(sessionCheckout.url);
          setSessionCheckout(null);
        }}
        onClose={() => setSessionCheckout(null)}
      />
    );
  return (
    <BottomSheet open detached onDismiss={onClose} accessibilityLabel={t('plus.payment.title')}>
      <View className="gap-4 p-5">
        <Text accessibilityRole="header">{t('plus.payment.title')}</Text>
        <Text>{t('plus.payment.description')}</Text>
        {offer?.price && (
          <>
            <Text>{offer.displayName}</Text>
            <Text>
              {t(
                `plus.payment.${offer.price.interval === 'year' ? 'yearlyPrice' : 'monthlyPrice'}`,
                {
                  price: new Intl.NumberFormat(i18n.language, {
                    style: 'currency',
                    currency: offer.price.currency,
                  }).format(plusPriceMajorUnits(offer.price)),
                },
              )}
            </Text>
            <PlusDisplayEstimate price={offer.price} />
          </>
        )}
        {(busy || message === 'loading') && (
          <ActivityIndicator accessibilityLabel={t('common.loading')} />
        )}
        {message && <Text accessibilityLiveRegion="polite">{t(`plus.payment.${message}`)}</Text>}
        {purchaseAvailable && !canUsePrivateApi && (
          <Button
            onPress={() => {
              void signIn();
            }}
          >
            {t('plus.payment.signIn')}
          </Button>
        )}
        {offer &&
          purchaseAvailable &&
          canUsePrivateApi &&
          !checkingAccess &&
          !accessFailed &&
          !done && (
            <Button
              disabled={busy}
              onPress={() => {
                void purchase(true);
              }}
            >
              {t('plus.payment.continue')}
            </Button>
          )}
        {offer && hostedUrl && (message === 'pending' || message === 'blocked') && (
          <Button
            disabled={busy}
            onPress={() => {
              void openHosted(hostedUrl);
            }}
          >
            {t('plus.payment.openCheckout')}
          </Button>
        )}
        {offer && hasOperation && !done && (
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
    </BottomSheet>
  );
}
