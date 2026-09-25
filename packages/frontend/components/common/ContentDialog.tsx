import React, { useEffect, useMemo, useState } from 'react';

import { Dialog, useDialogControl } from '@oxy.so/bloom/dialog';

interface ContentDialogRequest {
  /** Accessibility label for the surface — what the panel is about. */
  label: string;
  /**
   * Optional visible title. It is rendered in Bloom's dialog navigation header,
   * which also carries the close control.
   */
  title?: string;
  /** Renders the panel body. `close` dismisses the dialog. */
  render: (close: () => void) => React.ReactNode;
}

let openDialogRequest: ((request: ContentDialogRequest) => void) | null = null;
let closeDialog: (() => void) | null = null;

/**
 * Open a panel of CONTENT (a list, a detail view) on the app's overlay surface —
 * the same surface `showActionMenu` uses for actions, so the two cannot drift
 * into different shapes again: a centered card from `md` up, a bottom sheet
 * below it.
 *
 * Imperative for the same reason as the action menu: the surface is mounted ONCE
 * at the root (see {@link ContentDialogHost}), so a feed of a thousand posts
 * mounts one dialog rather than one per row.
 *
 * Content owns its own scrolling (these panels are lists), so the dialog does
 * not wrap it in a second scroll container.
 */
export function showContentDialog(request: ContentDialogRequest): void {
  openDialogRequest?.(request);
}

/** Close the content dialog. */
export function hideContentDialog(): void {
  closeDialog?.();
}

/**
 * The content panel surface. Mount once, at the app root (AppProviders).
 */
export function ContentDialogHost() {
  const control = useDialogControl();
  const [request, setRequest] = useState<ContentDialogRequest | null>(null);

  useEffect(() => {
    openDialogRequest = (next) => {
      setRequest(next);
      control.open();
    };
    closeDialog = () => control.close();
    return () => {
      openDialogRequest = null;
      closeDialog = null;
    };
  }, [control]);

  const title = request?.title;
  // A titled panel gets Bloom's navigation header: the title in a bar with a
  // close control, inset by the bar itself. It used to go through the
  // declarative `title`, which Bloom renders INSIDE the content padding, and
  // `contentPadding={0}` below (the list panels own their insets) left that
  // title flush with the sheet's edge and gave the panel no way to close but a
  // drag. `largeTitle: false` because the panels own their scrolling, so there
  // is no scroll for a large title to collapse under.
  const header = useMemo(
    () => (title ? { title, largeTitle: false } : undefined),
    [title],
  );

  return (
    <Dialog
      control={control}
      label={request?.label ?? ''}
      header={header}
      placement={{ base: 'bottom', md: 'center' }}
      // The panels render a `FlatList`: the dialog must hand them a bounded
      // height and let them scroll it, not nest a VirtualizedList in a
      // ScrollView.
      scrollable={false}
      // The panels carry their own header and row insets.
      contentPadding={0}
    >
      {request?.render(control.close) ?? null}
    </Dialog>
  );
}
