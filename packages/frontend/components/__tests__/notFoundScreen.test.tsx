/**
 * The app's one 404: Bloom's empty state with the `notFound` sticker, and a
 * single way out that goes home (replacing the broken entry, so Back does not
 * return to it). `+not-found` and `[username]` both render this.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ replace: mockReplace }) }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));
jest.mock('@/components/SEO', () => ({ SEO: () => null }));
jest.mock('@/components/common/EmptyState', () => ({ EmptyState: 'EmptyState' }));

import NotFoundScreen from '../NotFoundScreen';
import PlusNotFound from '../../app/(app)/+not-found';

function emptyStateOf(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findByType('EmptyState' as unknown as React.ElementType);
}

beforeEach(() => mockReplace.mockClear());

it('draws the notFound sticker with the 404 copy, and its one action goes home', () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<NotFoundScreen />);
  });
  const empty = emptyStateOf(renderer);
  expect(empty.props).toMatchObject({
    sticker: 'notFound',
    title: 'This page does not exist',
    subtitle: 'The link may be broken, or the page may have moved.',
  });
  expect(empty.props.action.label).toBe('Go to home');

  act(() => empty.props.action.onPress());
  expect(mockReplace).toHaveBeenCalledWith('/');
});

it('is the same screen the +not-found route renders', () => {
  expect(PlusNotFound).toBe(NotFoundScreen);
});
