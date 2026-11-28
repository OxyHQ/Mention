import TestRenderer, { act } from 'react-test-renderer';
import { PressableScale } from '@oxy.so/bloom/pressable-scale';
import { AccountAvatar } from '@/components/ui/AccountAvatar';
import { VideoRepostBubble } from '../VideoRepostBubble';

let mockUser: { id: string; avatar: string } | null = { id: 'viewer', avatar: 'actual.jpg' };
jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: () => ({ user: mockUser }) }));
jest.mock('@oxy.so/bloom/pressable-scale', () => ({ PressableScale: () => null }));
jest.mock('@/components/ui/AccountAvatar', () => ({ AccountAvatar: () => null }));
jest.mock('@oxy.so/bloom/icons/RiRepeat2Line', () => ({ RiRepeat2Line: () => null }));

beforeEach(() => {
  mockUser = { id: 'viewer', avatar: 'actual.jpg' };
});

it.each(['inactive', 'anonymous'])('does not render for %s', (state) => {
  if (state === 'anonymous') mockUser = null;
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<VideoRepostBubble visible={state !== 'inactive'} />);
  });
  expect(renderer.toJSON()).toBeNull();
  act(() => renderer.unmount());
});

it('exposes one quote button and delegates the action once', () => {
  const onAddThought = jest.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<VideoRepostBubble visible onAddThought={onAddThought} />);
  });
  const buttons = renderer.root.findAllByType(PressableScale);
  expect(buttons).toHaveLength(1);
  expect(buttons[0].props.accessibilityRole).toBe('button');
  act(() => buttons[0].props.onPress());
  expect(onAddThought).toHaveBeenCalledTimes(1);
  act(() => renderer.unmount());
});

it('keeps the real viewer badge without an interactive quote affordance when unavailable', () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<VideoRepostBubble visible />);
  });
  expect(renderer.root.findAllByType(PressableScale)).toHaveLength(0);
  expect(renderer.root.findByType(AccountAvatar).props).toMatchObject({
    account: mockUser,
    source: 'actual.jpg',
    size: 32,
  });
  act(() => renderer.unmount());
});
