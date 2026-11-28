import type React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Platform, Modal, ScrollView } from 'react-native';

jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: 'AnimatedAuditView' },
}));
jest.mock('@oxy.so/bloom/motion', () => ({
  ScaleAndFadeIn: 'audit-enter',
  ScaleAndFadeOut: 'audit-exit',
}));
jest.mock('@oxy.so/bloom/overlay', () => ({ Backdrop: 'AuditBackdrop' }));
jest.mock('@oxy.so/bloom/portal', () => ({
  Portal: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@oxy.so/bloom/button', () => ({ Button: 'AuditButton' }));
jest.mock('@oxy.so/bloom/icons/RiCloseLine', () => ({ RiCloseLine: 'AuditIcon' }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 12, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('react-native-gesture-handler', () => ({ GestureHandlerRootView: 'AuditGestureRoot' }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_: string, options?: { defaultValue?: string }) => options?.defaultValue ?? '',
  }),
}));
jest.mock('@/components/loading/ContentSkeleton', () => ({ DetailSkeleton: 'AuditSkeleton' }));
jest.mock('@/components/common/LinkifiedText', () => ({ LinkifiedText: 'AuditText' }));
jest.mock('@/services/articleService', () => ({ articleService: { getArticle: jest.fn() } }));

import PostArticleModal from '../PostArticleModal';

const originalPlatform = Object.getOwnPropertyDescriptor(Platform, 'OS');
afterEach(() => {
  if (originalPlatform) Object.defineProperty(Platform, 'OS', originalPlatform);
});

describe.each(['ios', 'android'] as const)('article modal candidate on %s', (os) => {
  beforeEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: os });
  });
  it('retains native modal, backdrop, inner touch handling and animations', () => {
    const onClose = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <PostArticleModal visible title="Title" body="Body" onClose={onClose} />,
      );
    });
    const root = renderer.root;
    const animated = root.findByType('AnimatedAuditView' as never);
    expect(animated.props.pointerEvents).toBe('box-none');
    expect(animated.props.entering).toBe('audit-enter');
    expect(animated.props.exiting).toBe('audit-exit');
    expect(root.findByType(Modal).props.visible).toBe(true);
    expect(root.findByType(Modal).props.statusBarTranslucent).toBe(os === 'android');
    expect(root.findByType(ScrollView)).toBeTruthy();
    const inside = root.findAll(
      (n) => typeof n.props.onPress === 'function' && n.props.style?.flex === 1,
    )[0];
    if (!inside) throw Error('no inside pressable');
    const stopPropagation = jest.fn();
    act(() => inside.props.onPress({ stopPropagation }));
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    act(() => root.findByType('AuditBackdrop' as never).props.onPress());
    act(() => root.findByType(Modal).props.onRequestClose());
    act(() => root.findByType('AuditButton' as never).props.onPress());
    expect(onClose).toHaveBeenCalledTimes(3);
    act(() => renderer.unmount());
  });
  it('renders no modal when hidden', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <PostArticleModal visible={false} body="Body" onClose={() => {}} />,
      );
    });
    expect(renderer.toJSON()).toBeNull();
    act(() => renderer.unmount());
  });
});
