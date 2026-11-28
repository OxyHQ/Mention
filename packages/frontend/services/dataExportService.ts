import { authenticatedClient } from '@/utils/api';

/** A large account's history is streamed in pages and takes longer than an ordinary read. */
export const DATA_EXPORT_TIMEOUT_MS = 5 * 60_000;

/**
 * Everything Mention holds that the viewer wrote or chose — posts, bookmarks,
 * likes and settings — as newline-delimited JSON, one record per line.
 *
 * The server writes the settings record last, so a body without it was cut off
 * and is rejected rather than saved as if it were the whole export.
 */
export async function fetchDataExport(): Promise<string> {
  const { data } = await authenticatedClient.post<string>('/profile/export', undefined, {
    timeout: DATA_EXPORT_TIMEOUT_MS,
  });
  const last = typeof data === 'string' ? data.trimEnd().split('\n').at(-1) : undefined;
  if (!last?.startsWith('{"type":"settings"')) throw new Error('The data export is incomplete');
  return data;
}
