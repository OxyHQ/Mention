import type {
  CommunityNoteHelpfulReason,
  CommunityNoteNotHelpfulReason,
  CommunityNoteRating,
  CommunityNoteSummary,
  HydratedPost,
} from '@mention/shared-types';
import { authenticatedClient } from '@/utils/api';

/**
 * Community notes, as the app asks for them.
 *
 * Every call lands on Mention's `/community-notes`, which forwards to
 * CrowdSource — the app never talks to CrowdSource, and never learns who wrote
 * or rated a note, because none of that travels back.
 *
 * The note shown UNDER a post does not come through here: it arrives attached to
 * the post itself, on the feed response, so a page costs no extra request.
 */

/** A note together with the post it is about. */
export interface CommunityNoteEntryPayload {
  post: HydratedPost;
  note: CommunityNoteSummary;
  /** Present on a drawn note: after this the rating is no longer accepted. */
  expiresAt?: string;
}

interface EntriesResponse {
  entries: CommunityNoteEntryPayload[];
}

export type CommunityNoteReason = CommunityNoteHelpfulReason | CommunityNoteNotHelpfulReason;

export interface WriteCommunityNoteInput {
  postId: string;
  text: string;
  sourceUrls: string[];
  /** The language the note is written in; the server falls back to the request's. */
  language?: string;
}

class CommunityNotesService {
  /** Whether this deployment can take notes at all. */
  async availability(): Promise<boolean> {
    const res = await authenticatedClient.get<{ enabled: boolean }>('/community-notes/availability');
    return res.data.enabled === true;
  }

  /** Writes a note about a post. Resolves once CrowdSource has it. */
  async write(input: WriteCommunityNoteInput): Promise<CommunityNoteSummary> {
    const res = await authenticatedClient.post<{ note: CommunityNoteSummary }>('/community-notes', input);
    return res.data.note;
  }

  /** Takes back a note this viewer wrote. */
  async withdraw(noteId: string): Promise<CommunityNoteSummary> {
    const res = await authenticatedClient.post<{ note: CommunityNoteSummary }>(
      `/community-notes/${encodeURIComponent(noteId)}/withdraw`,
    );
    return res.data.note;
  }

  /** Rates a note. Final — a second rating of the same note is refused. */
  async rate(noteId: string, rating: CommunityNoteRating, reasons: CommunityNoteReason[]): Promise<void> {
    await authenticatedClient.post(`/community-notes/${encodeURIComponent(noteId)}/ratings`, { rating, reasons });
  }

  /**
   * The viewer's rating queue.
   *
   * A POST because asking for it ISSUES the assignments that make a rating
   * possible; the server keys them so reopening the hub re-reads the same queue
   * rather than consuming a new one.
   */
  async toRate(): Promise<CommunityNoteEntryPayload[]> {
    const res = await authenticatedClient.post<EntriesResponse>('/community-notes/to-rate');
    return res.data.entries ?? [];
  }

  /** Notes this viewer wrote. */
  async mine(): Promise<CommunityNoteEntryPayload[]> {
    const res = await authenticatedClient.get<EntriesResponse>('/community-notes/mine');
    return res.data.entries ?? [];
  }

  /** Notes this viewer rated, each carrying the rating they gave. */
  async rated(): Promise<CommunityNoteEntryPayload[]> {
    const res = await authenticatedClient.get<EntriesResponse>('/community-notes/ratings');
    return res.data.entries ?? [];
  }
}

export const communityNotesService = new CommunityNotesService();
