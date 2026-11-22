import TestRenderer, { act } from 'react-test-renderer';
import { BloomProvider } from '@oxy.so/bloom/provider';
import type { ReactElement } from 'react';
import { AccountAvatar } from '@/components/ui/AccountAvatar';
import { VideoRepostBubble } from '../VideoRepostBubble';

let mockUser: { id: string; avatar: string } | null = { id: 'viewer', avatar: 'actual.jpg' };
jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: () => ({ user: mockUser }) }));
jest.mock('@/components/ui/AccountAvatar', () => ({ AccountAvatar: () => null }));
jest.mock('@oxy.so/bloom/icons/RiRepeat2Line', () => ({ RiRepeat2Line: () => null }));

/** The bubble draws language views, whose leaves paint from Bloom's theme. */
function create(element: ReactElement): TestRenderer.ReactTestRenderer {
  return TestRenderer.create(
    <BloomProvider fonts={false} haptics={false} defaultMode="light">
      {element}
    </BloomProvider>,
  );
}

/**
 * The quote affordances: each outermost pressable the bubble's test ID names (the
 * pressable's own inner hosts carry the same props, so the search stops at it).
 */
function quoteButtons(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    (node) =>
      node.props.testID === 'video-repost-thought' && typeof node.props.onPress === 'function',
    { deep: false },
  );
}

beforeEach(() => {
  mockUser = { id: 'viewer', avatar: 'actual.jpg' };
});

it.each(['inactive', 'anonymous'])('does not render for %s', (state) => {
  if (state === 'anonymous') mockUser = null;
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = create(<VideoRepostBubble visible={state !== 'inactive'} />);
  });
  expect(renderer.root.findByType(VideoRepostBubble).children).toHaveLength(0);
  act(() => renderer.unmount());
});

it('exposes one quote button and delegates the action once', () => {
  const onAddThought = jest.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = create(<VideoRepostBubble visible onAddThought={onAddThought} />);
  });
  const buttons = quoteButtons(renderer);
  expect(buttons).toHaveLength(1);
  expect(buttons[0].props.accessibilityRole).toBe('button');
  act(() => buttons[0].props.onPress());
  expect(onAddThought).toHaveBeenCalledTimes(1);
  act(() => renderer.unmount());
});

it('keeps the real viewer badge without an interactive quote affordance when unavailable', () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = create(<VideoRepostBubble visible />);
  });
  expect(quoteButtons(renderer)).toHaveLength(0);
  expect(renderer.root.findByType(AccountAvatar).props).toMatchObject({
    account: mockUser,
    source: 'actual.jpg',
    size: 32,
  });
  act(() => renderer.unmount());
});
