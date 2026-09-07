/**
 * The composer's stylesheet.
 *
 * Six hundred and forty lines of static `StyleSheet.create` data that sat at the
 * bottom of `ComposeScreen.tsx`, between the component and the session gate that
 * wraps it. Nothing here reads the theme or any prop — the theme-dependent colours
 * are applied inline at their call sites, and the one mention of
 * `theme.colors.primary` below is in a comment explaining why a connector is
 * painted inline rather than from here.
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
import { MEDIA_CARD_HEIGHT, MEDIA_CARD_WIDTH } from '@/utils/composeUtils';
// Centres the thread timeline on the avatar. Also already shared — the component
// imports it from the same module.
import { TIMELINE_LINE_OFFSET } from './composeLayout';

export const composeStyles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    minHeight: 48,
    // keep header clean (no divider)
  },
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
  /* header and icon tweaks */
  headerTitle: {
    position: 'absolute',
    // Not `left: 0, right: 0`: the buttons flanking it are 40pt wide and the
    // centred label ran underneath them — invisible until the colour was fixed,
    // and clipped once it was.
    left: 56,
    right: 156,
    textAlign: 'center',
    fontSize: 18,
    fontWeight: '700',
    pointerEvents: 'none', // Don't block touches on buttons
  },
  headerIcons: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 'auto',
  },
  iconBtn: {
    marginLeft: 8,
  },
  backBtn: {
    marginRight: 6,
  },

  /* bottom bar and floating post button */
  bottomBar: {
    borderTopWidth: StyleSheet.hairlineWidth,
    // A ScrollView stretches to fill its parent unless told not to; this row is
    // as tall as one pill.
    flexGrow: 0,
  },
  bottomBarContent: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  bottomText: {
    fontSize: 16,
    flex: 1,
  },
  sensitiveToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingLeft: 8,
  },
  replySettingsPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    gap: 5,
  },
  replySettingsText: {
    fontSize: 13,
    fontWeight: '500',
  },
  floatingCharCount: {
    position: 'absolute',
    right: 20,
    bottom: 16 + 48 + 8, // above floating post button
    fontSize: 12,
    fontWeight: '500',
  },
  floatingPostButton: {
    position: 'absolute',
    right: 16,
    bottom: 16,
    backgroundColor: '#fff',
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 16,
    boxShadow: '0px 0px 6px 0px rgba(0, 0, 0, 0.2)',
    elevation: 6,
  },
  floatingPostButtonDisabled: {
    backgroundColor: '#949494',
    opacity: 0.7,
  },
  floatingPostText: {
    fontSize: 16,
    fontWeight: '700',
  },
  floatingPostTextDark: {
    fontWeight: '700',
    fontSize: 16,
  },
  /* compose toolbar */
  toolbarDividerArea: {
    width: 28,
    alignItems: 'center',
  },
  toolbarDivider: {
    width: 1,
    height: 48,
    backgroundColor: '#ededed',
    borderRadius: 2,
  },
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
  toolbarWrapper: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 4,
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
  addToThreadText: {
    fontSize: 16,
  },
  replyPreviewLoading: {
    padding: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Post component structure styles
  postContainer: {
    flexDirection: 'column',
    gap: 12,
    paddingVertical: 12,
  },
  unfocusedItem: {
    opacity: 0.4,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  headerMeta: {
    flex: 1,
    paddingTop: 2,
    gap: 8,
  },
  headerChildren: {
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
  removeThreadBtn: {
    position: 'absolute',
    top: 0,
    right: 0,
    padding: 6,
  },
  // Timeline connector styles
  threadScrollView: {
    flex: 1,
  },
  threadScrollContent: {
    flexGrow: 1,
    paddingBottom: 80,
  },
  threadContainer: {
    position: 'relative',
  },
  // The connector's COLOUR is not here: it is the `bg-primary/20` className on
  // every connector <View>. `theme.colors.primary` resolves to `rgb(0 98 157)`,
  // so the `${primary}30` this used to interpolate was a malformed colour
  // string that react-native-web read back as FULLY OPAQUE — a solid primary bar
  // between the avatars instead of the faint 19% line the suffix asked for.
  itemConnectorLine: {
    position: 'absolute',
    left: TIMELINE_LINE_OFFSET,
    top: 60, // below avatar: 12px pad + 40px avatar + 8px gap
    bottom: 0,
    width: 2,
    borderRadius: 9999,
    zIndex: -1,
  },
  itemConnectorLineAbove: {
    position: 'absolute',
    left: TIMELINE_LINE_OFFSET,
    top: 0,
    height: 4, // from container top to 8px before avatar (12px pad - 8px gap)
    width: 2,
    borderRadius: 9999,
    zIndex: -1,
  },
  composerWithTimeline: {
    position: 'relative',
    zIndex: 2, // Above the timeline line
  },
  threadItemWithTimeline: {
    position: 'relative',
    zIndex: 2, // Above the timeline line
  },
  // Article attachment styles (still used in main compose)
  articleAttachmentWrapper: {
    position: 'relative',
    alignSelf: 'flex-start',
    width: MEDIA_CARD_WIDTH,
    height: MEDIA_CARD_HEIGHT,
    borderRadius: 15,
    borderWidth: 1,
    overflow: 'hidden',
  },
  articleAttachmentPreview: {
    flex: 1,
    width: '100%',
    height: '100%',
    padding: 16,
    borderWidth: 0,
    borderRadius: 0,
    backgroundColor: 'transparent',
    justifyContent: 'space-between',
  },
  // Poll attachment card styles (for thread items)
  pollAttachmentWrapper: {
    position: 'relative',
    alignSelf: 'flex-start',
  },
  pollAttachmentCard: {
    width: MEDIA_CARD_WIDTH,
    minHeight: 150,
    borderRadius: 15,
    borderWidth: 1,
    padding: 16,
    gap: 12,
  },
  pollAttachmentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  pollAttachmentBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  pollAttachmentBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  pollAttachmentMeta: {
    fontSize: 12,
    fontWeight: '500',
  },
  pollAttachmentQuestion: {
    fontSize: 16,
    fontWeight: '700',
  },
  pollAttachmentOptions: {
    gap: 8,
  },
  pollAttachmentOption: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  pollAttachmentOptionText: {
    fontSize: 13,
    fontWeight: '500',
  },
  pollAttachmentMore: {
    fontSize: 12,
    fontWeight: '500',
  },
  pollAttachmentRemoveButton: {
    position: 'absolute',
    top: 8,
    right: 8,
    borderRadius: 999,
    padding: 6,
  },
  // Media preview styles
  mediaPreviewContainer: {
    marginTop: 12,
    width: '100%',
    overflow: 'visible',
  },
  timelineForeground: {
    position: 'relative',
    zIndex: 2,
  },
  mediaPreviewScroll: {
    paddingRight: 12,
    gap: 12,
  },
  mediaPreviewItem: {
    width: MEDIA_CARD_WIDTH,
    height: MEDIA_CARD_HEIGHT,
    borderRadius: 15,
    borderWidth: 1,
    overflow: 'hidden',
    position: 'relative',
  },
  mediaPreviewImage: {
    width: '100%',
    height: '100%',
  },
  mediaRemoveButton: {
    position: 'absolute',
    top: 8,
    right: 8,
    borderRadius: 999,
    padding: 6,
  },
  mediaReorderControls: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    zIndex: 2,
  },
  mediaReorderButton: {
    borderRadius: 999,
    padding: 6,
  },
  mediaReorderButtonDisabled: {
    opacity: 0.4,
  },
  // Link attachment styles — the Bloom LinkPreviewCard owns its own border,
  // radius and surface, so the carousel wrapper only positions the card and its
  // move/remove controls.
  linkAttachmentWrapper: {
    position: 'relative',
    alignSelf: 'flex-start',
    width: MEDIA_CARD_WIDTH,
  },
  // Mode toggle styles
  modeToggleContainer: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  modeToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  modeOption: {
    flex: 1,
    alignItems: 'center',
  },
  modeLabel: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 2,
  },
  modeDescription: {
    fontSize: 12,
    textAlign: 'center',
  },
  modeToggle: {
    marginHorizontal: 20,
  },
  scheduleSheetContainer: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 28,
    gap: 16,
  },
  scheduleSheetTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  scheduleSheetSubtitle: {
    fontSize: 13,
  },
  scheduleSheetDivider: {
    height: StyleSheet.hairlineWidth,
    width: '100%',
  },
  scheduleOptionButton: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  scheduleOptionLabel: {
    fontSize: 15,
    fontWeight: '500',
  },
  scheduleOptionHint: {
    fontSize: 12,
    marginTop: 4,
  },
  scheduleCustomSection: {
    gap: 12,
  },
  scheduleCustomLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
  scheduleCustomInputsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  scheduleCustomInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    fontSize: 14,
  },
  scheduleSheetError: {
    fontSize: 12,
  },
  scheduleSheetActionButton: {
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  scheduleSheetActionText: {
    fontSize: 14,
    fontWeight: '600',
  },
  scheduleSheetActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  scheduleSheetSecondaryButton: {
    paddingVertical: 10,
    paddingHorizontal: 8,
  },
  scheduleSheetSecondaryText: {
    fontSize: 14,
    fontWeight: '500',
  },
});
