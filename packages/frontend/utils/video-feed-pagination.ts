interface VideoPageProgress {
  added: number;
  hasMore?: boolean;
  nextCursor?: string;
}

/** Following may return pages containing no videos; duplicates also make no progress. */
export async function loadVideoPagesUntilProgress(
  fetchPage: (cursor?: string) => Promise<VideoPageProgress | null>,
  startCursor?: string,
): Promise<void> {
  let cursor = startCursor;
  const visitedCursors = new Set<string>();
  // Bound automatic reads so a sparse Following feed cannot issue unlimited requests.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (cursor) visitedCursors.add(cursor);
    const page = await fetchPage(cursor);
    // null means the request failed or belongs to a feed the viewer has left.
    if (!page || page.added > 0 || !page.hasMore || !page.nextCursor) return;
    if (visitedCursors.has(page.nextCursor)) return;
    cursor = page.nextCursor;
  }
}
