import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import Feed from '../index';
import { useFeed } from '@/hooks/useFeed';
import { Text } from 'react-native';

// Mocking dependencies
jest.mock('@/hooks/useFeed');
jest.mock('../../Post', () => ({ postData }: any) => (
  <Text testID={`post-${postData.id}`}>{postData.text}</Text>
));
jest.mock('../../ErrorBoundary', () => ({ children }: any) => <>{children}</>);
jest.mock('../../Post/CreatePost', () => ({ onPress }: any) => (
  <Text testID="create-post" onPress={onPress}>Create Post</Text>
));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}));

describe('Feed Component', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useFeed as jest.Mock).mockReturnValue({
      posts: [],
      loading: false,
      refreshing: false,
      error: null,
      hasMore: false,
      fetchMore: jest.fn(),
      refresh: jest.fn()
    });
  });

  it('renders correctly with posts', () => {
    const mockPosts = [
      { id: '1', text: 'Test post 1' },
      { id: '2', text: 'Test post 2' }
    ];
    
    (useFeed as jest.Mock).mockReturnValue({
      posts: mockPosts,
      loading: false,
      refreshing: false,
      error: null,
      hasMore: false,
      fetchMore: jest.fn(),
      refresh: jest.fn()
    });

    render(<Feed />);
    expect(screen.getByTestId('post-1')).toBeTruthy();
    expect(screen.getByTestId('post-2')).toBeTruthy();
  });

  it('renders create post when showCreatePost is true', () => {
    render(<Feed showCreatePost={true} />);
    expect(screen.getByTestId('create-post')).toBeTruthy();
  });

  it('calls onCreatePostPress when create post is pressed', () => {
    const mockOnCreatePostPress = jest.fn();
    render(<Feed showCreatePost={true} onCreatePostPress={mockOnCreatePostPress} />);
    
    fireEvent.press(screen.getByTestId('create-post'));
    expect(mockOnCreatePostPress).toHaveBeenCalled();
  });

  it('shows error message when there is an error', () => {
    (useFeed as jest.Mock).mockReturnValue({
      posts: [],
      loading: false,
      refreshing: false,
      error: 'Failed to load feed',
      hasMore: false,
      fetchMore: jest.fn(),
      refresh: jest.fn()
    });

    render(<Feed />);
    expect(screen.getByText('Failed to load feed')).toBeTruthy();
    expect(screen.getByText('Tap to retry')).toBeTruthy();
  });

  it('shows empty message for following feed when no posts', () => {
    (useFeed as jest.Mock).mockReturnValue({
      posts: [],
      loading: false,
      refreshing: false,
      error: null,
      hasMore: false,
      fetchMore: jest.fn(),
      refresh: jest.fn()
    });

    render(<Feed type="following" />);
    expect(screen.getByText('No posts from people you follow yet')).toBeTruthy();
  });

  it('passes the correct feed type to useFeed', () => {
    render(<Feed type="following" />);
    expect(useFeed).toHaveBeenCalledWith({ type: 'following', parentId: undefined });
    
    render(<Feed type="media" />);
    expect(useFeed).toHaveBeenCalledWith({ type: 'media', parentId: undefined });
  });

  it('fetches more posts when reaching the end', () => {
    const mockFetchMore = jest.fn();
    (useFeed as jest.Mock).mockReturnValue({
      posts: [{ id: '1', text: 'Test post 1' }],
      loading: false,
      refreshing: false,
      error: null,
      hasMore: true,
      fetchMore: mockFetchMore,
      refresh: jest.fn()
    });

    const { getByTestId } = render(<Feed />);
    
    // Simulate reaching the end of the list
    fireEvent(getByTestId('post-1'), 'onEndReached');
    
    expect(mockFetchMore).toHaveBeenCalled();
  });

  it('refreshes the feed when pulled down', () => {
    const mockRefresh = jest.fn();
    (useFeed as jest.Mock).mockReturnValue({
      posts: [{ id: '1', text: 'Test post 1' }],
      loading: false,
      refreshing: false,
      error: null,
      hasMore: true,
      fetchMore: jest.fn(),
      refresh: mockRefresh
    });

    render(<Feed />);
    
    // Get the refresh control and trigger refresh
    const flatList = screen.UNSAFE_getByType('RCTScrollView');
    const { refreshControl } = flatList.props;
    fireEvent(refreshControl, 'refresh');
    
    expect(mockRefresh).toHaveBeenCalled();
  });
});