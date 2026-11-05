import type { ReactNode } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

const mockReplace = jest.fn();
const mockMutate = jest.fn((_: unknown, options: { onSettled: () => void }) => options.onSettled());
let mockNext: string | undefined;

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@/lib/navigation/router', () => ({
  useRouter: () => ({ replace: mockReplace }),
  useLocalSearchParams: () => ({ next: mockNext }),
}));
jest.mock('@/hooks/useWelcome', () => ({
  useCompleteWelcome: () => ({ mutate: mockMutate, isPending: false }),
}));
jest.mock('@/components/settings/settingsRoutes', () => ({ requestSettings: jest.fn() }));
jest.mock('@/components/interests/TopicPicker', () => ({ TopicPicker: () => 'topics' }));
jest.mock('@/components/sharedRouteScreens', () => ({ LazyWhoToFollowTab: () => 'people' }));
jest.mock('../WelcomeStarterPacks', () => ({ WelcomeStarterPacks: () => null }));
jest.mock('@oxy.so/bloom/button-group', () => {
  const item = ({ children, onPress }: { children: ReactNode; onPress: () => void }) => {
    const { Text } = require('react-native');
    return <Text onPress={onPress}>{children}</Text>;
  };
  return {
    ButtonGroup: ({ children }: { children: ReactNode }) => children,
    ButtonGroupItem: item,
  };
});
jest.mock('@oxy.so/bloom/card', () => {
  const pass = ({ children }: { children?: ReactNode }) => children;
  return { CardHeader: pass, CardBody: pass, CardTitle: pass, CardDescription: pass };
});
jest.mock('@oxy.so/bloom/button', () => {
  const press = ({ children, onPress }: { children: ReactNode; onPress: () => void }) => {
    const { Text } = require('react-native');
    return <Text onPress={onPress}>{children}</Text>;
  };
  return { Button: press, LinkButton: press };
});
jest.mock('@oxy.so/bloom/typography', () => ({
  Title: ({ children }: { children: ReactNode }) => children,
  Text: ({ children }: { children: ReactNode }) => children,
  Muted: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@oxy.so/bloom/icons/RiArrowLeftLine', () => ({ RiArrowLeftLine: () => null }));
jest.mock('@oxy.so/bloom/screen', () => ({
  Screen: ({ header, bottomBar, children }: Record<string, ReactNode>) => (
    <>
      {header}
      {children}
      {bottomBar}
    </>
  ),
  ScreenScrollView: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@oxy.so/bloom/page-header', () => ({
  PageHeader: ({
    leading,
    actions,
    accessory,
  }: {
    leading: ReactNode;
    actions: ReactNode;
    accessory: ReactNode;
  }) => (
    <>
      {leading}
      {actions}
      {accessory}
    </>
  ),
}));
jest.mock('@oxy.so/bloom/wizard', () => ({
  WizardProgress: ({ current }: { current: number }) => `step-${current}`,
}));
jest.mock('@oxy.so/bloom/page-footer', () => ({
  PageFooter: ({ children, actions }: { children: ReactNode; actions: ReactNode }) => (
    <>
      {children}
      {actions}
    </>
  ),
}));

import { WelcomeScreen } from '../WelcomeScreen';

function press(renderer: ReactTestRenderer, label: string) {
  const node = renderer.root.findAll(
    (n) => n.props.onPress && (n.props.children === label || n.props.accessibilityLabel === label),
  )[0];
  if (!node) throw new Error(`no "${label}" control`);
  act(() => node.props.onPress());
}

function text(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function mount(next?: string) {
  mockNext = next;
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<WelcomeScreen />);
  });
  return renderer;
}

describe('WelcomeScreen', () => {
  afterEach(() => jest.clearAllMocks());

  it('walks interests, people and profile, then records it and goes home', () => {
    const renderer = mount();
    expect(text(renderer)).toContain('step-0');
    press(renderer, 'welcome.next');
    expect(text(renderer)).toContain('people');
    press(renderer, 'welcome.back');
    expect(text(renderer)).toContain('topics');
    press(renderer, 'welcome.next');
    press(renderer, 'welcome.next');
    expect(text(renderer)).toContain('welcome.profile.title');
    press(renderer, 'welcome.finish');
    expect(mockMutate).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/');
  });

  it('skips straight to where the person was going, and never off-site', () => {
    press(mount('/p/123'), 'welcome.skip');
    expect(mockReplace).toHaveBeenLastCalledWith('/p/123');
    press(mount('//evil.example'), 'welcome.skip');
    expect(mockReplace).toHaveBeenLastCalledWith('/');
  });
});
