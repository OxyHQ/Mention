import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { SEO } from '../SEO';

jest.mock('react-native', () => ({ Platform: { OS: 'web' } }));
jest.mock('expo-router', () => ({ usePathname: () => '/', useFocusEffect: jest.fn() }));
jest.mock('expo-router/head', () => ({ __esModule: true, default: ({ children }: { children: React.ReactNode }) => children }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, options: { defaultValue: string }) => options.defaultValue }) }));
jest.mock('@/config', () => ({ WEB_BASE_URL: 'https://social.example/' }));

let tree: TestRenderer.ReactTestRenderer;
afterEach(() => { act(() => tree?.unmount()); });

test('default social card advertises the real image with its dimensions and accessible description', () => {
  act(() => { tree = TestRenderer.create(<SEO url="https://social.example/" />); });
  const meta = (key: string) => tree.root.findAllByType('meta').find(node => node.props.property === key || node.props.name === key)?.props.content;
  expect(meta('og:image')).toBe('https://social.example/og-image.jpg');
  expect(meta('twitter:image')).toBe(meta('og:image'));
  expect(meta('og:image:width')).toBe('1280');
  expect(meta('og:image:height')).toBe('720');
  expect(meta('og:image:type')).toBe('image/jpeg');
  expect(meta('og:image:alt')).toContain('friends and a dog');
  expect(meta('twitter:image:alt')).toBe(meta('og:image:alt'));
});

test('personalized entity images do not inherit homepage image dimensions or description', () => {
  act(() => { tree = TestRenderer.create(<SEO url="https://social.example/" image="https://cdn.example/avatar.png" robots="noindex,nofollow" />); });
  const nodes = tree.root.findAllByType('meta');
  expect(nodes.find(node => node.props.property === 'og:image')?.props.content).toBe('https://cdn.example/avatar.png');
  expect(nodes.find(node => node.props.name === 'robots')?.props.content).toBe('noindex,nofollow');
  expect(nodes.filter(node => ['og:image:width', 'og:image:height', 'og:image:type', 'og:image:alt', 'twitter:image:alt'].includes(node.props.property || node.props.name))).toHaveLength(0);
});

test('unready entity routes keep their existing server head', () => {
  act(() => { tree = TestRenderer.create(<SEO url="https://social.example/" ready={false} />); });
  expect(tree.toJSON()).toBeNull();
});
