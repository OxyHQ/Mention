/** Project untrusted input onto the opaque reference, discarding every snapshot. */
export const sanitizePodcast = (input: unknown): { syraPodcastId: string } | null => {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  const syraPodcastId = typeof obj.syraPodcastId === 'string' ? obj.syraPodcastId.trim() : '';
  if (!syraPodcastId || syraPodcastId.length > 256) return null;
  return { syraPodcastId };
};
