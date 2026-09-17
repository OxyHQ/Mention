import React, { lazy, Suspense, useCallback, useContext } from 'react';
import { useRouter } from 'expo-router';
import type { CommunityNoteRating, CommunityNoteSummary, HydratedPostSummary } from '@mention/shared-types';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { openExternalLink } from '@/utils/openExternalLink';
import type { CommunityNoteDraft } from './WriteNoteSheet';

// Loaded when a sheet first opens, never with the post row: every feed row
// mounts this hook, and none of them should pay for the forms (the same reason
// `PostItem` lazy-loads its own sheets).
const WritingTipsSheet = lazy(() => import('./WritingTipsSheet').then((m) => ({ default: m.WritingTipsSheet })));
const WriteNoteSheet = lazy(() => import('./WriteNoteSheet').then((m) => ({ default: m.WriteNoteSheet })));
const NoteSubmittedSheet = lazy(() => import('./NoteSubmittedSheet').then((m) => ({ default: m.NoteSubmittedSheet })));
const RateNoteSheet = lazy(() => import('./RateNoteSheet').then((m) => ({ default: m.RateNoteSheet })));
const AboutNoteSheet = lazy(() => import('./AboutNoteSheet').then((m) => ({ default: m.AboutNoteSheet })));

/** Where "Learn more" goes: the public explainer for how notes work. */
export const COMMUNITY_NOTES_HELP_URL = 'https://mention.earth/help/community-notes';
/** The notes hub: rate notes, your ratings, your notes. */
export const COMMUNITY_NOTES_ROUTE = '/community-notes';

export interface CommunityNoteWriteHandlers {
  /** Sends the note (to CrowdSource, through Mention). Resolves once accepted. */
  submitNote?: (postId: string, draft: CommunityNoteDraft) => Promise<void>;
  /** Sends a rating with its reasons. Resolves once accepted. */
  rateNote?: (noteId: string, rating: CommunityNoteRating, reasons: string[]) => Promise<void>;
}

/**
 * The community-note flows, as bottom sheets swapped in place in the app's one
 * sheet:
 *
 * - write: writing tips → the note form → "submitted"
 * - rate: Helpful / Not helpful → why → done
 * - about: what a note is, with the rating choice
 *
 * Writes are the caller's (`handlers`): CrowdSource owns notes, and the sheets
 * only collect what the reader chose.
 */
export function useCommunityNoteSheets(handlers: CommunityNoteWriteHandlers = {}) {
  const bottomSheet = useContext(BottomSheetContext);
  const router = useRouter();
  const { submitNote, rateNote } = handlers;

  const close = useCallback(() => bottomSheet.openBottomSheet(false), [bottomSheet]);

  const show = useCallback(
    (content: React.ReactNode, scrollable = false) => {
      bottomSheet.setBottomSheetContent(<Suspense fallback={null}>{content}</Suspense>, { scrollable });
      bottomSheet.openBottomSheet(true);
    },
    [bottomSheet],
  );

  const openManageNotes = useCallback(() => {
    close();
    router.push(COMMUNITY_NOTES_ROUTE);
  }, [close, router]);

  const openWriteForm = useCallback(
    (post: HydratedPostSummary) => {
      show(
        <WriteNoteSheet
          post={post}
          onClose={close}
          onSubmit={async (draft) => {
            await submitNote?.(post.id, draft);
            show(<NoteSubmittedSheet onDone={close} onManageNotes={openManageNotes} />);
          }}
        />,
        true,
      );
    },
    [show, close, submitNote, openManageNotes],
  );

  const openWriteFlow = useCallback(
    (post: HydratedPostSummary) => {
      show(
        <WritingTipsSheet
          onClose={close}
          onContinue={() => openWriteForm(post)}
          onLearnMore={() => openExternalLink(COMMUNITY_NOTES_HELP_URL)}
        />,
      );
    },
    [show, close, openWriteForm],
  );

  const openRateReasons = useCallback(
    (note: CommunityNoteSummary, rating: CommunityNoteRating, onRated?: (rating: CommunityNoteRating) => void) => {
      show(
        <RateNoteSheet
          rating={rating}
          onClose={close}
          onSubmit={async (reasons) => {
            await rateNote?.(note.id, rating, reasons);
            onRated?.(rating);
            close();
          }}
        />,
      );
    },
    [show, close, rateNote],
  );

  const openAbout = useCallback(
    (note: CommunityNoteSummary) => {
      show(
        <AboutNoteSheet note={note} onClose={close} onRate={rateNote ? (rating) => openRateReasons(note, rating) : undefined} />,
        true,
      );
    },
    [show, close, openRateReasons, rateNote],
  );

  // A flow is offered only when something can receive what it collects: a
  // "submitted" sheet for a note that went nowhere would lie to the writer.
  return {
    openWriteFlow,
    openRateReasons,
    openAbout,
    openManageNotes,
    canWrite: Boolean(submitNote),
    canRate: Boolean(rateNote),
  };
}
