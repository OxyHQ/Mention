import type React from 'react';
import { lazy, Suspense, useMemo } from 'react';
import type { SurfaceControls } from '@oxy.so/bloom/surfaces';
import { useRouter } from '@/lib/navigation/router';
import type {
  CommunityNoteRating,
  CommunityNoteSummary,
  HydratedPostSummary,
} from '@mention/shared-types';
import { openExternalLink } from '@/utils/openExternalLink';
import { presentSheet } from '@/utils/sheet';
import type { CommunityNoteDraft } from './WriteNoteSheet';

// Loaded when a sheet first opens, never with the post row: every feed row
// mounts this hook, and none of them should pay for the forms (the same reason
// `PostItem` lazy-loads its own sheets).
const WritingTipsSheet = lazy(() =>
  import('./WritingTipsSheet').then((m) => ({ default: m.WritingTipsSheet })),
);
const WriteNoteSheet = lazy(() =>
  import('./WriteNoteSheet').then((m) => ({ default: m.WriteNoteSheet })),
);
const NoteSubmittedSheet = lazy(() =>
  import('./NoteSubmittedSheet').then((m) => ({ default: m.NoteSubmittedSheet })),
);
const RateNoteSheet = lazy(() =>
  import('./RateNoteSheet').then((m) => ({ default: m.RateNoteSheet })),
);
const AboutNoteSheet = lazy(() =>
  import('./AboutNoteSheet').then((m) => ({ default: m.AboutNoteSheet })),
);

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

export interface CommunityNoteSheets {
  openWriteFlow: (post: HydratedPostSummary) => void;
  openRateReasons: (
    note: CommunityNoteSummary,
    rating: CommunityNoteRating,
    onRated?: (rating: CommunityNoteRating) => void,
  ) => void;
  openAbout: (note: CommunityNoteSummary) => void;
  openManageNotes: () => void;
  canWrite: boolean;
  canRate: boolean;
}

/**
 * The community-note flows, as sheets on the app's surface stack, each step
 * replacing the one before it:
 *
 * - write: writing tips → the note form → "submitted"
 * - rate: Helpful / Not helpful → why → done
 * - about: what a note is, with the rating choice
 *
 * Writes are the caller's (`handlers`): CrowdSource owns notes, and the sheets
 * only collect what the reader chose.
 *
 * A plain factory, not a hook: feed rows reach it through the shared
 * `usePostInteractions()` controller, built once for the app, so a row pays for
 * none of these closures (issue #1103). Screens that own the flows directly use
 * the `useCommunityNoteSheets` wrapper below.
 */
export function createCommunityNoteSheets({
  router,
  handlers = {},
}: {
  router: ReturnType<typeof useRouter>;
  handlers?: CommunityNoteWriteHandlers;
}): CommunityNoteSheets {
  const { submitNote, rateNote } = handlers;

  type Step = (surface: SurfaceControls) => React.ReactNode;

  const show = (step: Step, scrollable = false) => {
    void presentSheet((surface) => <Suspense fallback={null}>{step(surface)}</Suspense>, {
      scrollable,
    });
  };

  /** The next step of a flow takes the place of the sheet it was opened from. */
  const next = (from: SurfaceControls, step: Step, scrollable = false) => {
    from.dismiss();
    show(step, scrollable);
  };

  const openManageNotes = () => router.push(COMMUNITY_NOTES_ROUTE);

  const submitted: Step = (surface) => (
    <NoteSubmittedSheet
      onDone={() => surface.dismiss()}
      onManageNotes={() => {
        surface.dismiss();
        openManageNotes();
      }}
    />
  );

  const writeForm = (surface: SurfaceControls, post: HydratedPostSummary) => (
    <WriteNoteSheet
      post={post}
      onClose={() => surface.dismiss()}
      onSubmit={async (draft) => {
        await submitNote?.(post.id, draft);
        next(surface, submitted);
      }}
    />
  );

  const openWriteFlow = (post: HydratedPostSummary) => {
    show((surface) => (
      <WritingTipsSheet
        onClose={() => surface.dismiss()}
        onContinue={() => next(surface, (form) => writeForm(form, post), true)}
        onLearnMore={() => openExternalLink(COMMUNITY_NOTES_HELP_URL)}
      />
    ));
  };

  const rateReasons = (
    surface: SurfaceControls,
    note: CommunityNoteSummary,
    rating: CommunityNoteRating,
    onRated?: (rating: CommunityNoteRating) => void,
  ) => (
    <RateNoteSheet
      rating={rating}
      onClose={() => surface.dismiss()}
      onSubmit={async (reasons) => {
        await rateNote?.(note.id, rating, reasons);
        onRated?.(rating);
        surface.dismiss();
      }}
    />
  );

  const openRateReasons: CommunityNoteSheets['openRateReasons'] = (note, rating, onRated) => {
    show((surface) => rateReasons(surface, note, rating, onRated));
  };

  const openAbout = (note: CommunityNoteSummary) => {
    show(
      (surface) => (
        <AboutNoteSheet
          note={note}
          onClose={() => surface.dismiss()}
          onRate={
            rateNote
              ? (rating) => next(surface, (reasons) => rateReasons(reasons, note, rating))
              : undefined
          }
        />
      ),
      true,
    );
  };

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

/** The flows for a screen that owns them (the notes hub). */
export function useCommunityNoteSheets(
  handlers: CommunityNoteWriteHandlers = {},
): CommunityNoteSheets {
  const router = useRouter();
  const { submitNote, rateNote } = handlers;
  return useMemo(
    () => createCommunityNoteSheets({ router, handlers: { submitNote, rateNote } }),
    [router, submitNote, rateNote],
  );
}
