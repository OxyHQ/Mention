import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import MentionPicker from '../MentionPicker';
import { createMentionSearchCache, type MentionUser } from '@/utils/mentionSearch';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key }),
}));
jest.mock('@oxy.so/bloom/card', () => {
  const { View } = jest.requireActual('react-native');
  return { Card: ({ children }: { children: React.ReactNode }) => <View>{children}</View> };
});
jest.mock('@oxy.so/bloom/loading', () => {
  const { Text: RNText } = jest.requireActual('react-native');
  return { Loading: () => <RNText>loading</RNText> };
});
jest.mock('@oxy.so/bloom/avatar', () => ({ Avatar: () => null }));
jest.mock('@/components/UserName', () => {
  const { Text: RNText } = jest.requireActual('react-native');
  return { __esModule: true, default: ({ handle }: { handle: string }) => <RNText>{`@${handle}`}</RNText> };
});
jest.mock('@/components/common/EmptyState', () => {
  const { Text: RNText } = jest.requireActual('react-native');
  return { EmptyState: ({ title }: { title: string }) => <RNText>{title}</RNText> };
});

const alice: MentionUser = { id: 'alice-id', username: 'alice' };

function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root.findAllByType(Text).map((node) => String(node.props.children));
}

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  jest.useRealTimers();
});

describe('MentionPicker', () => {
  it('shows what the session already searched for without asking again', async () => {
    const fetchUsers = jest.fn(async () => [alice]);
    const cache = createMentionSearchCache(fetchUsers);
    await cache.search('ali');

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <MentionPicker query="ali" searchCache={cache} onSelect={jest.fn()} onClose={jest.fn()} />,
      );
    });

    expect(texts(renderer)).toEqual(['@alice']);
    expect(fetchUsers).toHaveBeenCalledTimes(1);
  });

  it('searches through the cache after the debounce, and says so when nobody matches', async () => {
    jest.useFakeTimers();
    const fetchUsers = jest.fn(async (query: string) => (query === 'ali' ? [alice] : []));
    const cache = createMentionSearchCache(fetchUsers);
    const onSelect = jest.fn();
    const onClose = jest.fn();

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <MentionPicker query="ali" searchCache={cache} onSelect={onSelect} onClose={onClose} />,
      );
    });
    expect(fetchUsers).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    expect(fetchUsers).toHaveBeenCalledWith('ali');
    expect(texts(renderer)).toEqual(['@alice']);

    act(() => {
      renderer.root.findByProps({ className: 'border-b-border' }).props.onPress();
    });
    expect(onSelect).toHaveBeenCalledWith(alice);
    expect(onClose).toHaveBeenCalled();

    act(() => {
      renderer.update(
        <MentionPicker query="zed" searchCache={cache} onSelect={onSelect} onClose={onClose} />,
      );
    });
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    expect(texts(renderer)).toEqual(['No users found']);
  });

  it('shows nothing for an empty query and survives a failed search', async () => {
    jest.useFakeTimers();
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const cache = createMentionSearchCache(async () => {
      throw new Error('offline');
    });

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <MentionPicker query="" searchCache={cache} onSelect={jest.fn()} onClose={jest.fn()} />,
      );
    });
    expect(renderer.toJSON()).toBeNull();

    act(() => {
      renderer.update(
        <MentionPicker query="ali" searchCache={cache} onSelect={jest.fn()} onClose={jest.fn()} />,
      );
    });
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    expect(texts(renderer)).toEqual(['No users found']);
    error.mockRestore();
  });
});
