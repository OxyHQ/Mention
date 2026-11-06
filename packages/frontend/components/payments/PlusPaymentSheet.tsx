import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Platform, View } from 'react-native';
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
import {
  PeableSheetCheckout,
  sheetSourceFromUrl,
  type SheetCheckoutSource,
} from '@peable.to/sdk/checkout/ui';
import { clearPlusCheckoutKey, getPlusCheckoutKey } from '@/lib/payments/plusCheckoutStorage';

/** How often Mention asks Oxy for the outcome once Peable closed the order. */
const OUTCOME_POLL_MS = 3000;

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
}: {
  onClose(): void;
  cadence?: PlusCadence;
}) {
  const { user } = useAuth();
  const { activeSessionId } = useOxy();
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
  // The pending Peable order, paid in Peable's sheet (the SDK's PeableSheetCheckout).
  const [sessionCheckout, setSessionCheckout] = useState<{
    source: SheetCheckoutSource;
    url: string;
  } | null>(null);
  // Peable closed the order; until Oxy answers, Mention keeps asking.
  const [settled, setSettled] = useState(false);
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
          const source = sheetSourceFromUrl(url);
          // Card and FairCoin are chosen in Peable's sheet over the same order;
          // a URL that is not a Peable session stays a hosted page.
          if (source?.type === 'checkout_session') {
            setSettled(false);
            setSessionCheckout({ source, url });
          } else setHostedUrl(url);
        }
      } else {
        // Fulfilled: the sheet shows Peable's success and closes itself. Anything
        // else ends the sheet, and this dialog says what Oxy answered.
        if (result.state !== 'fulfilled') setSessionCheckout(null);
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
  // Once Peable closed the order, only Oxy's answer can grant access: ask until
  // it is no longer pending.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `purchase` reads the current scope itself.
  useEffect(() => {
    if (!settled || message !== 'pending') return;
    const poll = setInterval(() => {
      void purchase(false);
    }, OUTCOME_POLL_MS);
    return () => clearInterval(poll);
  }, [settled, message]);

  /** The hosted page, from the press that asked for it: the web window is
   * reserved before any await, so a popup blocker sees the gesture. */
  const openHosted = async (url: string) => {
    const attemptScope = scope.current;
    const isCurrent = () => attemptScope.active && scope.current === attemptScope;
    popup.current?.close();
    const windowForAttempt =
      Platform.OS === 'web'
        ? window.open('about:blank', '_blank', 'popup,width=480,height=720')
        : null;
    if (windowForAttempt) windowForAttempt.opener = null;
    popup.current = windowForAttempt;
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
  if (sessionCheckout && offer?.price && canUsePrivateApi)
    return (
      <PeableSheetCheckout
        key={sessionCheckout.source.id}
        source={sessionCheckout.source}
        locale={i18n.language}
        // The reviewed offer: Peable compares it with the session's price before tax.
        expected={{
          amount: String(offer.price.amountMinorUnits),
          currency: offer.price.currency,
        }}
        presentation={{
          merchant: 'Mention',
          recurring: { interval: offer.price.interval },
          itemDetail: () =>
            t(`plus.payment.cadence${offer.price?.interval === 'year' ? 'Year' : 'Month'}`),
        }}
        openUrl={async (url, kind) => {
          // The Peable wallet's request by its link; Peable's secure page (the
          // card on a phone) the way every hosted page here opens.
          if (kind === 'hosted') await openHosted(url);
          else if (Platform.OS === 'web') window.location.href = url;
          else await Linking.openURL(url);
        }}
        onSettled={() => {
          // The gateway closed the order; only Oxy's answer can grant access.
          setSettled(true);
          void purchase(false);
        }}
        outcome={message === 'fulfilled' ? 'succeeded' : null}
        onUnavailable={() => {
          setHostedUrl(sessionCheckout.url);
          setSessionCheckout(null);
        }}
        onClose={() => {
          setSessionCheckout(null);
          if (message === 'fulfilled') onClose();
        }}
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
