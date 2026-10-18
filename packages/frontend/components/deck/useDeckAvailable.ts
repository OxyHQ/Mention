import { BREAKPOINTS } from '@oxy.so/bloom/styles';
import { Platform, useWindowDimensions } from 'react-native';

/** Deck is a desktop web workspace; never mount its feeds on compact screens. */
export function useDeckAvailable() {
  const { width } = useWindowDimensions();
  return Platform.OS === 'web' && width >= BREAKPOINTS.lg;
}
