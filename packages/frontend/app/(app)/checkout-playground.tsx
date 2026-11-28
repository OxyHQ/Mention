import type { ComponentType } from 'react';
import { Text } from '@oxy.so/bloom/typography';

// A compile-time boundary: production must not ship developer fixtures or their assets.
const Playground: ComponentType | null = __DEV__
  ? require('../../components/payments/CheckoutPlaygroundScreen').default
  : null;

export default function CheckoutPlaygroundRoute() {
  return Playground ? <Playground /> : <Text>Not available</Text>;
}
