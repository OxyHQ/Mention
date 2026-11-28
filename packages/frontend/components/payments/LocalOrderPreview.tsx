import { useRef, useState } from 'react';
import { Image as ShapeImage } from '@oxy.so/bloom/shapes';
import { useTranslation } from 'react-i18next';
import {
  PeableOrderDetailsSheet,
  availableOrderReward,
  matchingRewardOffers,
  type OrderRewardScreen,
  type PeableOrderDetails,
  type PeableOrderReward,
} from '@peable.to/sdk/checkout/ui';

/** Explicit physical-order UI fixture. No reward/provider call, persisted claim or entitlement. */
export function LocalOrderPreview({
  paidMinorUnits,
  payments,
  onClose,
}: {
  paidMinorUnits: number;
  payments: PeableOrderDetails['payments'];
  onClose(): void;
}) {
  const { i18n } = useTranslation();
  const es = i18n.language.startsWith('es');
  const [screen, setScreen] = useState<OrderRewardScreen>('order');
  const [categories, setCategories] = useState<string[]>([]);
  const [offerId, setOfferId] = useState<string>();
  const [claimed, setClaimed] = useState(false);
  const claimAccepted = useRef(false);
  const [error, setError] = useState<string>();
  const artwork = (
    <ShapeImage
      shape="squircle"
      size={160}
      source={require('../../assets/images/mention-icon.png')}
      alt="Mention"
    />
  );
  const order: PeableOrderDetails = {
    id: 'local-order-sticker-pack',
    merchant: 'Mention',
    placedOn: 'November 3, 2026',
    currency: 'USD',
    totalMinorUnits: 2800,
    paidMinorUnits,
    remainingMinorUnits: 2800 - paidMinorUnits,
    items: [
      {
        id: 'sticker-pack',
        name: es ? 'Pack de pegatinas Mention' : 'Mention sticker pack',
        detail: es ? '1 artículo' : '1 item',
        artwork: (
          <ShapeImage
            shape="squircle"
            size={40}
            source={require('../../assets/images/mention-icon.png')}
            alt="Mention"
          />
        ),
      },
    ],
    payments,
  };
  const reward: PeableOrderReward = {
    orderId: order.id,
    eligible: !claimed,
    title: es ? 'Un regalo para ti' : 'A gift for you',
    description: es
      ? 'Elige un detalle de Mention para acompañar tu pedido.'
      : 'Choose a little extra from Mention to go with your order.',
    expiresAt: '2027-01-01T00:00:00Z',
    deadlineLabel: es ? 'Elige antes del 1 de enero de 2027' : 'Choose before January 1, 2027',
    minimumCategories: 2,
    categories: [
      { id: 'art', label: es ? 'Arte y diseño' : 'Art and design' },
      { id: 'stationery', label: es ? 'Papelería' : 'Stationery' },
      { id: 'digital', label: es ? 'Personalización digital' : 'Digital personalization' },
    ],
    terms: [
      es
        ? 'Una elección por pedido. Es opcional y no modifica tus pagos.'
        : 'One choice per order. Optional, with no change to your payments.',
    ],
    offers: [
      {
        id: 'stickers',
        title: es ? 'Mini pack de pegatinas' : 'Mini sticker pack',
        description: es
          ? 'Tres diseños de Mention para tu colección.'
          : 'Three Mention designs for your collection.',
        artwork,
        categoryIds: ['art', 'stationery', 'digital'],
        terms: [
          es
            ? 'Incluido sin coste adicional con este pedido.'
            : 'Included at no additional cost with this order.',
          es
            ? 'Se envía con tu pedido a la misma dirección. No canjeable por dinero.'
            : 'Ships with your order to the same address. No cash alternative.',
        ],
      },
      {
        id: 'icons',
        title: es ? 'Colección de iconos' : 'Icon collection',
        description: es
          ? 'Una colección de diseños de Mention para personalizar tu espacio.'
          : 'A collection of Mention designs to personalize your space.',
        artwork,
        categoryIds: ['art', 'digital', 'stationery'],
        terms: [
          es
            ? 'Contenido digital sin coste adicional. No inicia una suscripción.'
            : 'Digital content at no additional cost. Does not start a subscription.',
          es
            ? 'Una colección por pedido. No canjeable por dinero.'
            : 'One collection per order. No cash alternative.',
        ],
      },
    ],
  };
  const now = Date.now();
  return (
    <PeableOrderDetailsSheet
      open
      locale={i18n.language}
      order={order}
      reward={reward}
      now={now}
      screen={screen}
      selectedCategories={categories}
      selectedOfferId={offerId}
      claimError={error}
      claimedOffer={claimed ? reward.offers.find((offer) => offer.id === offerId) : undefined}
      onScreen={setScreen}
      onCategories={(ids) => {
        setCategories(ids);
        setOfferId(undefined);
      }}
      onOffer={setOfferId}
      onClose={onClose}
      onClaim={(offer) => {
        if (claimAccepted.current) return;
        if (
          !availableOrderReward(order.id, reward, Date.now()) ||
          !matchingRewardOffers(reward, categories).some((candidate) => candidate.id === offer.id)
        ) {
          setError(es ? 'Este regalo ya no está disponible.' : 'This gift is no longer available.');
          return;
        }
        claimAccepted.current = true;
        setClaimed(true);
        setOfferId(offer.id);
        setError(undefined);
        setScreen('claimed');
      }}
    />
  );
}
