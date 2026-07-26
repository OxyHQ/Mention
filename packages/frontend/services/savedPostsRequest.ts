export interface SavedPostsRequest {
  page?: number;
  limit?: number;
  search?: string;
  folder?: string;
  signal?: AbortSignal;
}

export function buildBookmarkFolderMoveRequest(
  postId: string,
  folder: string | null,
): {
  url: string;
  data: { folder: string | null };
} {
  return {
    url: `/posts/bookmarks/by-post/${encodeURIComponent(postId)}/folder`,
    data: { folder },
  };
}

/**
 * Keep the pagination/filter transport contract small and independently
 * testable. In particular, the AbortSignal must survive unchanged from
 * TanStack Query to the linked HTTP client.
 */
export function buildSavedPostsRequestConfig(request: SavedPostsRequest): {
  params: Record<string, unknown>;
  signal?: AbortSignal;
} {
  const params: Record<string, unknown> = {
    page: request.page || 1,
    limit: request.limit || 20,
  };

  if (request.search) {
    params.search = request.search;
  }
  if (request.folder) {
    params.folder = request.folder;
  }

  return {
    params,
    signal: request.signal,
  };
}
