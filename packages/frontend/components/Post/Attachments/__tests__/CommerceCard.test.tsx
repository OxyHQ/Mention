import TestRenderer, { act } from 'react-test-renderer';
import { Linking } from 'react-native';
import { CommerceCard } from '../CommerceCard';
import { commerceService } from '@/services/commerceService';

let mockSnapshot: { status: string; value?: unknown } = { status: 'loading' };
jest.mock('@/hooks/useVisibleReference', () => ({ useVisibleReference: () => mockSnapshot }));
jest.mock('@oxy.so/bloom/video-playback', () => ({ useViewableVisible: () => true }));
jest.mock('@/lib/references/commerceCards', () => ({
  commerceCards: {},
  recordCommerceHandoff: (id: string) =>
    jest
      .requireMock('@/services/commerceService')
      .commerceService.recordMetric('posts', id, 'handoff'),
}));
jest.mock('@/services/commerceService', () => ({
  commerceService: { recordMetric: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: 'es' },
  }),
}));
let renderer: TestRenderer.ReactTestRenderer;
const screen = () => JSON.stringify(renderer.toJSON());
const links = () =>
  renderer.root.findAll(
    (node) => node.props.accessibilityRole === 'link' && typeof node.props.onPress === 'function',
  );
beforeEach(() => {
  mockSnapshot = { status: 'loading' };
  jest.clearAllMocks();
});
afterEach(() => {
  act(() => renderer?.unmount());
  jest.restoreAllMocks();
});

it('reserves space but offers no outgoing action until current facts are ready', () => {
  act(() => {
    renderer = TestRenderer.create(<CommerceCard referenceId="mercaria:product:p1" height={240} />);
  });
  expect(renderer.root.findByProps({ testID: 'commerce-card' }).props.style).toEqual({
    height: 240,
  });
  expect(links()).toHaveLength(0);
  expect(screen()).toContain('Checking current availability');
  expect(commerceService.recordMetric).not.toHaveBeenCalled();
});

it('uses the canonical formatter, shows sold state, and removes both price and handoff on expiry', () => {
  const formatPrice = jest.fn(() => '129,00 €');
  mockSnapshot = {
    status: 'ready',
    value: {
      product: { title: 'Current item', availability: 'sold', primaryImage: null },
      url: 'https://mercaria.co/products/p1',
      formatPrice,
    },
  };
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  act(() => {
    renderer = TestRenderer.create(
      <CommerceCard referenceId="mercaria:product:p1" postId="post-1" />,
    );
  });
  expect(formatPrice).toHaveBeenCalledWith('es');
  expect(screen()).toContain('129,00 €');
  expect(screen()).toContain('commerce.availability.sold');
  expect(commerceService.recordMetric).not.toHaveBeenCalled();
  const stopPropagation = jest.fn();
  act(() => links()[0].props.onPress({ stopPropagation }));
  expect(stopPropagation).toHaveBeenCalled();
  expect(open).toHaveBeenCalledWith('https://mercaria.co/products/p1');
  expect(commerceService.recordMetric).toHaveBeenCalledWith('posts', 'post-1', 'handoff');
  mockSnapshot = { status: 'loading' };
  act(() => renderer.update(<CommerceCard referenceId="mercaria:product:p1" postId="post-1" />));
  expect(screen()).not.toContain('129,00 €');
  expect(screen()).not.toContain('Current item');
  expect(links()).toHaveLength(0);
  mockSnapshot = { status: 'unavailable' };
  act(() => renderer.update(<CommerceCard referenceId="mercaria:product:p1" postId="post-1" />));
  expect(screen()).toContain('currently unavailable');
});

it('renders collection handoff without fabricating product pricing', () => {
  mockSnapshot = {
    status: 'ready',
    value: {
      collection: { title: 'A collection', image: null },
      url: 'https://mercaria.co/collections/c1',
    },
  };
  act(() => {
    renderer = TestRenderer.create(<CommerceCard referenceId="mercaria:collection:c1" />);
  });
  expect(screen()).toContain('A collection');
  expect(screen()).not.toContain('€');
  expect(links().length).toBeGreaterThan(0);
});
