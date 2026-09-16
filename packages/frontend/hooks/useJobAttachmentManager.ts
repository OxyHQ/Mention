import { useState, useCallback } from 'react';
import type { PostJobContent } from '@mention/shared-types';

/**
 * The Mention job the composer has attached to the ROOT post. Only
 * `mentionJobId` is sent to the backend (`PostJobInput`, mirrored in
 * `utils/postBuilder.ts` exactly the way `podcast: {syraPodcastId}` already
 * is) — the rest is `PostJobContent`, the same denormalized shape
 * `components/Post/JobCard.tsx` renders, kept locally so the compose preview
 * needs no round-trip.
 *
 * Scope note (issue #952): this manager wires the ROOT/single post only.
 * Thread items (beast mode boxes, thread continuations) and draft
 * save/restore do not carry a job attachment yet — see the TODOs in
 * `components/Compose/ComposeScreen.tsx` and `utils/postBuilder.ts`.
 */
export type JobAttachmentData = PostJobContent;

export const useJobAttachmentManager = () => {
  const [job, setJob] = useState<JobAttachmentData | null>(null);

  const saveJob = useCallback((next: JobAttachmentData) => {
    setJob(next);
  }, []);

  const removeJob = useCallback(() => {
    setJob(null);
  }, []);

  const hasContent = useCallback(() => Boolean(job?.mentionJobId), [job]);

  const clearJob = useCallback(() => {
    setJob(null);
  }, []);

  return {
    job,
    setJob,
    saveJob,
    removeJob,
    hasContent,
    clearJob,
  };
};
