import { renderHook, act } from '@testing-library/react-hooks';
import { useFeed } from '../useFeed';
import { fetchData } from '@/utils/api';

// Mock the api fetch function
jest.mock('@/utils/api', () => ({
  fetchData: jest.fn()
}));

describe('useFeed', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('fetches explore feed correctly', async () => {
    const mockResponse = {
      data: {
        posts: [{ id: '1', text: 'Test post' }],
        nextCursor: 'next-123',
        hasMore: true
      }
    };

    (fetchData as jest.Mock).mockResolvedValueOnce(mockResponse);

    const { result, waitForNextUpdate } = renderHook(() => useFeed({ type: 'all' }));
    
    expect(result.current.loading).toBe(true);
    
    await waitForNextUpdate();
    
    expect(fetchData).toHaveBeenCalledWith('feed/explore', { params: { limit: 20 } });
    expect(result.current.posts).toEqual(mockResponse.data.posts);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.loading).toBe(false);
  });

  it('fetches following feed correctly', async () => {
    const mockResponse = {
      data: {
        posts: [{ id: '2', text: 'Following post' }],
        nextCursor: 'next-456',
        hasMore: true
      }
    };

    (fetchData as jest.Mock).mockResolvedValueOnce(mockResponse);

    const { result, waitForNextUpdate } = renderHook(() => useFeed({ type: 'following' }));
    
    expect(result.current.loading).toBe(true);
    
    await waitForNextUpdate();
    
    expect(fetchData).toHaveBeenCalledWith('feed/following', { params: { limit: 20 } });
    expect(result.current.posts).toEqual(mockResponse.data.posts);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.loading).toBe(false);
  });

  it('handles refresh correctly', async () => {
    const mockResponse1 = {
      data: {
        posts: [{ id: '1', text: 'Initial post' }],
        nextCursor: 'next-123',
        hasMore: true
      }
    };

    const mockResponse2 = {
      data: {
        posts: [{ id: '2', text: 'New post' }],
        nextCursor: 'next-456',
        hasMore: true
      }
    };

    (fetchData as jest.Mock).mockResolvedValueOnce(mockResponse1);

    const { result, waitForNextUpdate } = renderHook(() => useFeed({ type: 'following' }));
    
    await waitForNextUpdate();
    
    expect(result.current.posts).toEqual(mockResponse1.data.posts);

    // Setup mock for refresh call
    (fetchData as jest.Mock).mockResolvedValueOnce(mockResponse2);

    // Trigger refresh
    act(() => {
      result.current.refresh();
    });

    expect(result.current.refreshing).toBe(true);
    
    await waitForNextUpdate();

    expect(fetchData).toHaveBeenCalledWith('feed/following', { params: { limit: 20 } });
    expect(result.current.posts).toEqual(mockResponse2.data.posts);
    expect(result.current.refreshing).toBe(false);
  });

  it('handles fetchMore correctly', async () => {
    const mockResponse1 = {
      data: {
        posts: [{ id: '1', text: 'First post' }],
        nextCursor: 'next-cursor',
        hasMore: true
      }
    };

    const mockResponse2 = {
      data: {
        posts: [{ id: '2', text: 'Second post' }],
        nextCursor: null,
        hasMore: false
      }
    };

    (fetchData as jest.Mock).mockResolvedValueOnce(mockResponse1);

    const { result, waitForNextUpdate } = renderHook(() => useFeed({ type: 'following' }));
    
    await waitForNextUpdate();
    
    expect(result.current.posts).toEqual(mockResponse1.data.posts);
    expect(result.current.hasMore).toBe(true);

    // Setup mock for fetchMore call
    (fetchData as jest.Mock).mockResolvedValueOnce(mockResponse2);

    // Trigger fetchMore
    act(() => {
      result.current.fetchMore();
    });

    await waitForNextUpdate();

    expect(fetchData).toHaveBeenCalledWith('feed/following', { 
      params: { limit: 20, cursor: 'next-cursor' } 
    });
    
    // Should append new posts to existing ones
    expect(result.current.posts).toEqual([
      ...mockResponse1.data.posts,
      ...mockResponse2.data.posts
    ]);
    
    expect(result.current.hasMore).toBe(false);
  });

  it('handles errors correctly', async () => {
    const error = new Error('Network error');
    (fetchData as jest.Mock).mockRejectedValueOnce(error);

    const { result, waitForNextUpdate } = renderHook(() => useFeed({ type: 'following' }));
    
    await waitForNextUpdate();
    
    expect(result.current.error).toBe('Network error');
    expect(result.current.loading).toBe(false);
  });
});