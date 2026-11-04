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
jest.mock('@/components/WhoToFollowTab', () => ({ WhoToFollowTab: () => 'people' }));
jest.mock('../WelcomeStarterPacks', () => ({ WelcomeStarterPacks: () => null }));
jest.mock('@oxy.so/bloom/button', () => ({
  Button: ({ children, onPress }: { children: ReactNode; onPress: () => void }) => {
    const { Text } = require('react-native');
    return <Text onPress={onPress}>{children}</Text>;
  },
}));
jest.mock('@oxy.so/bloom/typography', () => ({
  Title: ({ children }: { children: ReactNode }) => children,
  Muted: ({ children }: { children: ReactNode }) => children,
}));
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
jest.mock('@oxy.so/bloom/wizard', () => ({
  WizardProgress: ({ current, action }: { current: number; action: ReactNode }) => (
    <>
      {`step-${current}`}
      {action}
    </>
  ),
  WizardFooter: ({ onBack, onNext }: { onBack?: () => void; onNext: () => void }) => {
    const { Text } = require('react-native');
    return (
      <>
        {onBack ? <Text onPress={onBack}>back</Text> : null}
        <Text onPress={onNext}>next</Text>
      </>
    );
  },
}));

import { WelcomeScreen } from '../WelcomeScreen';

function press(renderer: ReactTestRenderer, label: string) {
  const node = renderer.root.findAll((n) => n.props.onPress && n.props.children === label)[0];
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
    press(renderer, 'next');
    expect(text(renderer)).toContain('people');
    press(renderer, 'back');
    expect(text(renderer)).toContain('topics');
    press(renderer, 'next');
    press(renderer, 'next');
    expect(text(renderer)).toContain('welcome.profile.heading');
    press(renderer, 'next');
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
