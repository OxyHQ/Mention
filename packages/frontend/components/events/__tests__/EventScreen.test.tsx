import type { ReactNode } from 'react';
import type { EventState } from '@oxy.so/mention-contracts';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Switch } from 'react-native';
import EventScreen from '../../../app/(app)/events/[id]';

let mockUser = 'attendee';
let mockEvent: EventState;
const mockRegister = jest.fn(async (_id: string, publicAttendance: boolean) => {
  mockEvent = { ...mockEvent, viewerAttendance: { public: publicAttendance } };
  return mockEvent;
});
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ user: { id: mockUser }, signIn: jest.fn() }),
}));
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: 'event-one' }) }));
jest.mock('@/hooks/useSafeBack', () => ({ useSafeBack: () => jest.fn() }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options: { defaultValue: string }) => options.defaultValue,
  }),
}));
jest.mock('@oxy.so/bloom/button', () => {
  const React = require('react');
  return {
    Button: (props: { children: ReactNode; onPress(): void; disabled?: boolean }) =>
      React.createElement('button', props, props.children),
  };
});
jest.mock('@oxy.so/bloom/page-header', () => ({ PageHeader: () => null }));
jest.mock('@oxy.so/bloom/screen', () => {
  const { View: MockView } = jest.requireActual('react-native');
  const Pass = ({ children }: { children: ReactNode }) => <MockView>{children}</MockView>;
  return { Screen: Pass, ScreenScrollView: Pass };
});
jest.mock('@/components/Compose/EventEditor', () => ({ EventEditor: () => null }));
jest.mock('@/services/eventsService', () => ({
  eventsService: {
    get: async () => mockEvent,
    register: (...args: [string, boolean]) => mockRegister(...args),
    attendees: async () => ({ items: [], nextCursor: null }),
  },
}));

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
async function mount() {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(
      <QueryClientProvider client={cache}>
        <EventScreen />
      </QueryClientProvider>,
    );
  });
  await settle();
  return { tree, cache };
}
function button(tree: TestRenderer.ReactTestRenderer, label: string) {
  return tree.root.findAll(
    (node) => (node.type as unknown) === 'button' && node.props.children === label,
  )[0];
}
beforeEach(() => {
  mockUser = 'attendee';
  mockRegister.mockClear();
  mockEvent = {
    postId: 'event-one',
    name: 'Community meeting',
    date: new Date(Date.now() + 60000).toISOString(),
    capacity: 1,
    cancelled: false,
    revision: 0,
    attendingCount: 0,
    viewerAttendance: null,
    canManage: false,
  };
});
it('registers privately by default and refuses a full event in the UI', async () => {
  const { tree, cache } = await mount();
  expect(tree.root.findByType(Switch).props.value).toBe(false);
  await act(async () => {
    button(tree, 'Register').props.onPress();
  });
  await settle();
  expect(mockRegister).toHaveBeenCalledWith('event-one', false);
  act(() => tree.unmount());
  cache.clear();
  mockEvent = { ...mockEvent, viewerAttendance: null, attendingCount: 1 };
  const full = await mount();
  expect(button(full.tree, 'Register').props.disabled).toBe(true);
  act(() => full.tree.unmount());
  full.cache.clear();
});
it.each(['started', 'cancelled'])(
  'lets an attendee hide public attendance after the event is %s',
  async (state) => {
    mockEvent = {
      ...mockEvent,
      viewerAttendance: { public: true },
      date: new Date(Date.now() + (state === 'started' ? -60000 : 60000)).toISOString(),
      cancelled: state === 'cancelled',
    };
    const { tree, cache } = await mount();
    expect(button(tree, 'Register')).toBeUndefined();
    expect(button(tree, 'Save visibility choice').props.disabled).toBe(true);
    act(() => tree.root.findByType(Switch).props.onValueChange(false));
    expect(button(tree, 'Save visibility choice').props.disabled).toBe(false);
    await act(async () => button(tree, 'Save visibility choice').props.onPress());
    await settle();
    expect(mockRegister).toHaveBeenCalledWith('event-one', false);
    expect(tree.root.findAllByType(Switch)).toHaveLength(0);
    act(() => tree.unmount());
    cache.clear();
  },
);

it('clears unsaved public visibility when the signed-in account changes', async () => {
  const { tree, cache } = await mount();
  act(() => tree.root.findByType(Switch).props.onValueChange(true));
  expect(tree.root.findByType(Switch).props.value).toBe(true);
  mockUser = 'another-attendee';
  await act(async () => {
    tree.update(
      <QueryClientProvider client={cache}>
        <EventScreen />
      </QueryClientProvider>,
    );
  });
  await settle();
  expect(tree.root.findByType(Switch).props.value).toBe(false);
  await act(async () => button(tree, 'Register').props.onPress());
  await settle();
  expect(mockRegister).toHaveBeenCalledWith('event-one', false);
  act(() => tree.unmount());
  cache.clear();
});
