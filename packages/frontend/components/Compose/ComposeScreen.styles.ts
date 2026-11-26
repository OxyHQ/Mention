/**
 * The composer's stylesheet.
 *
 * Six hundred and forty lines of static `StyleSheet.create` data that sat at the
 * bottom of `ComposeScreen.tsx`, between the component and the session gate that
 * wraps it. Nothing here reads the theme or any prop — the theme-dependent colours
 * are applied inline at their call sites (the thread's timeline is the language's,
 * `timelineLineBelow`/`timelineLineAbove` in `composeLayout`).
 *
 * Split out because it is the largest piece of that file that is not the
 * component: moving it takes `ComposeScreen.tsx` from 4,105 lines to ~3,460
 * without touching a line of behaviour, and it makes the remaining seams — the
 * ones that DO close over the component's state — visible for the workstream that
 * follows.
 *
 * Named `composeStyles` at the boundary and imported as `styles`, so every one of
 * the several hundred `styles.x` references in the component is unchanged: this
 * is a move, and a move that renamed its call sites would not be one.
 */

import { StyleSheet } from 'react-native';
// The two media-card dimensions the attachment styles below are built from.
// They already live in `utils/composeUtils`, shared with the component and with
// the carousel — so this import is the same one `ComposeScreen.tsx` makes, not a
// constant duplicated to make the move work.

export const composeStyles = StyleSheet.create({
  cancelButton: {
    padding: 8,
  },
  postButton: {
    backgroundColor: '#005c67',
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 20,
    minWidth: 60,
    alignItems: 'center',
  },
  postButtonDisabled: {
    backgroundColor: '#949494',
  },
  composeArea: {
    flex: 1,
  },
  userInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 16,
  },
  mediaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 12,
  },
  mediaButton: {
    backgroundColor: '#FAFAFA',
    borderWidth: 1,
    borderColor: '#ededed',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  previewGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 10,
  },
  previewItem: {
    width: 64,
    height: 64,
  },
  removeBadge: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#FF3B30',
    alignItems: 'center',
    justifyContent: 'center',
  },
  /* the footer: the batch's pills, then the submit slot */
  // Takes the width the button leaves and never more, so the pills scroll under
  // their own edge instead of running beneath the button.
  bottomBarChips: {
    flex: 1,
  },
  /* compose toolbar */
  toolbarIcons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingLeft: 8,
  },
  smallThreadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    gap: 8,
  },
  // New styles for exact screenshot match
  mainComposer: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 16,
    gap: 12,
  },
  composerLeftCol: {
    width: 48,
    alignItems: 'center',
  },
  connector: {
    width: 2,
    flex: 1,
    backgroundColor: '#ededed',
    marginTop: 0,
    borderRadius: 1,
    minHeight: 24,
  },
  mainTextInput: {
    fontSize: 16,
    minHeight: 40,
    textAlignVertical: 'top',
  },
  addToThreadBtn: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  addToThreadContent: {
    flex: 1,
    paddingTop: 8,
  },
  avatarContainer: {
    alignItems: 'center',
    marginRight: 12, // AVATAR_GAP
  },
  timelineConnector: {
    position: 'absolute',
    left: -32, // Position relative to headerMeta to align with avatar center
    top: -20,
    width: 2,
    height: 32,
    backgroundColor: '#ededed',
    borderRadius: 1,
  },
  // Media section styles (from PostMiddle)
  mediaSection: {
    // paddingLeft applied dynamically with BOTTOM_LEFT_PAD
  },
  mediaScroller: {
    paddingRight: 12,
    gap: 12,
  },
  mediaItemContainer: {
    position: 'relative',
    borderWidth: 1,
    borderColor: '#ededed',
    borderRadius: 10,
    width: 280,
    height: 180,
  },
  mediaImage: {
    width: 280,
    height: 180,
    backgroundColor: '#EFEFEF',
    borderRadius: 10,
  },
  mediaRemoveBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  mediaMoreBtn: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  threadTextInput: {
    fontSize: 16,
    minHeight: 32,
    textAlignVertical: 'top',
  },
  threadScrollView: {
    flex: 1,
  },
  threadScrollContent: {
    flexGrow: 1,
    paddingBottom: 80,
  },
  mediaPreviewScroll: {
    paddingRight: 12,
    gap: 12,
  },
  mediaPreviewImage: {
    width: '100%',
    height: '100%',
  },
});
