import TestRenderer, { act } from 'react-test-renderer';
import { AccountAvatar } from '../AccountAvatar';
import { AccountAvatarGroup } from '../AccountAvatarGroup';

let mockShared = false;
const mockAvatar = jest.fn((_props: unknown) => null);
const mockGroup = jest.fn((_props: unknown) => null);
const mockCapability = jest.fn(() => ({ sharedLiveRendering: mockShared }));
jest.mock('@oxy.so/bloom/agent-avatar', () => ({
  parseAvatarCharacter: jest.requireActual(
    require('node:path').join(
      require.resolve('@oxy.so/bloom/package.json'),
      '../src/agent-avatar/character.ts',
    ),
  ).parseAvatarCharacter,
  useAvatarRendererCapabilities: () => mockCapability(),
}));
jest.mock('@oxy.so/bloom/avatar-group', () => ({
  AvatarGroup: (props: unknown) => mockGroup(props),
}));
jest.mock('@oxy.so/bloom/avatar', () => ({ Avatar: (props: unknown) => mockAvatar(props) }));

afterEach(() => {
  mockShared = false;
  mockAvatar.mockClear();
  mockGroup.mockClear();
  mockCapability.mockClear();
});

it('changes motion only when the shared backend becomes compatible and preserves explicit policy', () => {
  const account = {
    kind: 'bot' as const,
    character: {
      shape: 'rounded_head_two_ears',
      eyes: 'oval',
      color: 'teal',
      eyewear: 'none',
      accessory: 'none',
    },
  };
  let tree: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<AccountAvatar account={account} source="photo" alt="Agent" />);
  });
  expect(mockAvatar.mock.lastCall?.[0]).toMatchObject({
    account,
    source: 'photo',
    alt: 'Agent',
    motion: 'auto',
  });
  mockShared = true;
  act(() => {
    tree.update(<AccountAvatar account={account} />);
  });
  expect(mockAvatar.mock.lastCall?.[0]).toMatchObject({ account, motion: 'always' });
  act(() => {
    tree.update(<AccountAvatar account={account} motion="never" />);
  });
  expect(mockAvatar.mock.lastCall?.[0]).toMatchObject({ motion: 'never' });
  mockShared = false;
  act(() => {
    tree.update(<AccountAvatar account={account} />);
  });
  expect(mockAvatar.mock.lastCall?.[0]).toMatchObject({ motion: 'auto' });
  act(() => tree.unmount());
});

it('does not probe native capabilities for human photos, remote accounts or malformed characters', () => {
  for (const account of [
    { kind: 'personal' as const, avatar: 'photo' },
    { kind: 'bot' as const, avatar: 'remote-photo' },
    { kind: 'bot' as const, character: { shape: 'not-a-shape' } },
  ]) {
    let tree: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(<AccountAvatar account={account} />);
    });
    expect(mockAvatar.mock.lastCall?.[0]).toMatchObject({ account });
    act(() => tree.unmount());
  }
  expect(mockCapability).not.toHaveBeenCalled();
});

it('keeps group capability hooks out of photo-only lists and follows mixed-group compatibility', () => {
  const photos = [{ id: 'human', kind: 'personal', uri: 'photo' }];
  const bot = {
    id: 'bot',
    kind: 'bot',
    character: {
      shape: 'rounded_head_two_ears',
      eyes: 'oval',
      color: 'teal',
      eyewear: 'none',
      accessory: 'none',
    },
  };
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<AccountAvatarGroup items={photos} layout="cluster" size={40} />);
  });
  expect(mockCapability).not.toHaveBeenCalled();
  expect(mockGroup.mock.lastCall?.[0]).toMatchObject({
    items: photos,
    layout: 'cluster',
    size: 40,
  });
  const mixed = [...photos, bot];
  act(() => tree.update(<AccountAvatarGroup items={mixed} layout="cluster" size={40} />));
  expect(mockGroup.mock.lastCall?.[0]).toMatchObject({ items: mixed, motion: 'auto' });
  mockShared = true;
  act(() => tree.update(<AccountAvatarGroup items={mixed} />));
  expect(mockGroup.mock.lastCall?.[0]).toMatchObject({ motion: 'always' });
  mockCapability.mockClear();
  act(() => tree.update(<AccountAvatarGroup items={mixed} motion="never" />));
  expect(mockCapability).not.toHaveBeenCalled();
  expect(mockGroup.mock.lastCall?.[0]).toMatchObject({ motion: 'never' });
  act(() => tree.update(<AccountAvatarGroup items={photos} />));
  expect(mockCapability).not.toHaveBeenCalled();
  act(() => tree.unmount());
});
