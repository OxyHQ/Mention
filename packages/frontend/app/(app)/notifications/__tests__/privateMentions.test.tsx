import type React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PrivateMentionConversation } from '@mention/shared-types';

/**
 * The private-mentions inbox screen: each conversation becomes one Bloom
 * `ChatListItem` naming who it is with, previewing the newest post and opening
 * the thread root; an empty or failed read stays inside the list. The hook is
 * stubbed (it has its own test); the rows run for real.
 */

const mockPush = jest.fn();
const mockHook = {
  conversations: [] as PrivateMentionConversation[],
  isLoading: false,
  isError: false,
  isRefetching: false,
  hasNextPage: false,
  isFetchingNextPage: false,
  loadMore: jest.fn(),
  refetch: jest.fn(),
};

jest.mock('@/hooks/usePrivateMentionConversations', () => ({
  usePrivateMentionConversations: () => mockHook,
}));
jest.mock('@/lib/navigation/router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('@oxy.so/services/ui/client', () => ({
  OxyAuthPrompt: () => null,
  queryKeys: { users: { detail: (id: string) => ['users', id] } },
  useAuth: () => ({
    user: { id: 'viewer' },
    isAuthResolved: true,
    isPrivateApiPending: false,
    canUsePrivateApi: true,
  }),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: Record<string, unknown>) =>
      String(options?.defaultValue ?? _key).replace(/\{\{(\w+)\}\}/g, (_m, name: string) =>
        String(options?.[name] ?? ''),
      ),
  }),
}));
jest.mock('@oxy.so/bloom/screen', () => ({
  Screen: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@oxy.so/bloom/page-header', () => ({ PageHeader: () => null }));
jest.mock('@oxy.so/bloom/theme', () => ({
  useTheme: () => ({ colors: { textSecondary: '#666' } }),
}));
jest.mock('@oxy.so/bloom/chat-list', () => ({
  ChatListItem: 'ChatListItem',
  ChatListItemSkeleton: 'ChatListItemSkeleton',
}));
jest.mock('@/components/SEO', () => ({ SEO: () => null }));
jest.mock('@/components/common/EmptyState', () => ({ EmptyState: 'EmptyState' }));
jest.mock('@oxy.so/bloom/list', () => ({
  VirtualList: ({
    data,
    renderItem,
    keyExtractor,
    ListEmptyComponent,
  }: {
    data: unknown[];
    renderItem: (info: { item: unknown }) => React.ReactElement;
    keyExtractor: (item: unknown) => string;
    ListEmptyComponent: React.ReactElement;
  }) =>
    data.length === 0
      ? ListEmptyComponent
      : data.map((item) => <span key={keyExtractor(item)}>{renderItem({ item })}</span>),
}));

import PrivateMentionsScreen from '../private-mentions';

function conversation(
  rootId: string,
  participantIds: string[],
  author: { id: string; username: string; displayName?: string },
  text: string,
): PrivateMentionConversation {
  return {
    rootId,
    lastActivityAt: new Date().toISOString(),
    postCount: 1,
    participantIds,
    latestPost: {
      id: `${rootId}-latest`,
      user: { id: author.id, username: author.username, name: { displayName: author.displayName } },
      content: { text },
    } as unknown as PrivateMentionConversation['latestPost'],
  };
}

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  client.setQueryData(['users', 'u2'], {
    id: 'u2',
    username: 'luis',
    name: { displayName: 'Luis' },
  });
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      <QueryClientProvider client={client}>
        <PrivateMentionsScreen />
      </QueryClientProvider>,
    );
  });
  return tree;
}

describe('private mentions screen', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockHook.conversations = [];
    mockHook.isError = false;
    mockHook.isLoading = false;
  });

  it('names each conversation, previews its newest post and opens its thread', () => {
    mockHook.conversations = [
      conversation('root-1', ['u1'], { id: 'u1', username: 'ana', displayName: 'Ana' }, 'hi'),
      conversation('root-2', ['u1', 'u2', 'u3'], { id: 'viewer', username: 'me' }, 'plan'),
    ];
    const rows = render().root.findAllByType('ChatListItem' as unknown as React.ElementType);

    expect(rows.map((row) => row.props.name)).toEqual(['Ana', 'Luis and 2 more']);
    expect(rows[0].props.preview).toEqual({ text: 'hi', sender: undefined });
    expect(rows[1].props.preview).toEqual({ text: 'plan', sender: 'You' });

    act(() => rows[1].props.onPress());
    expect(mockPush).toHaveBeenCalledWith('/p/root-2');
  });

  it('names a pair, credits the other sender in a group, and falls back for media and unknowns', () => {
    const media = conversation('root-4', ['u9'], { id: 'u9', username: '' }, '');
    (media.latestPost.content as { media?: unknown[] }).media = [{ id: 'm1' }];
    mockHook.conversations = [
      conversation('root-3', ['u1', 'u2'], { id: 'u1', username: 'ana', displayName: 'Ana' }, 'yo'),
      media,
    ];
    const rows = render().root.findAllByType('ChatListItem' as unknown as React.ElementType);

    expect(rows[0].props.name).toBe('Ana and Luis');
    expect(rows[0].props.preview).toEqual({ text: 'yo', sender: 'Ana' });
    expect(rows[1].props.name).toBe('Private mentions');
    expect(rows[1].props.preview.attachment.label).toBe('Media');
  });

  it('keeps an empty or failed read inside the list', () => {
    const empty = render().root.findByType('EmptyState' as unknown as React.ElementType);
    expect(empty.props.title).toBe('No private mentions yet');

    mockHook.isError = true;
    const failed = render().root.findByType('EmptyState' as unknown as React.ElementType);
    expect(failed.props.error.title).toBe("Couldn't load private mentions");

    mockHook.isError = false;
    mockHook.isLoading = true;
    expect(
      render().root.findAllByType('ChatListItemSkeleton' as unknown as React.ElementType),
    ).not.toHaveLength(0);
  });
});
