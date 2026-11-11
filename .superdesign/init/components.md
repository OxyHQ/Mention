# Mention UI primitives and shared video content
React Native/Expo, Bloom is the component library (Screen, PageHeader, IconButton, SegmentedControl, VirtualList). No app-owned parallel primitives.
## packages/frontend/components/common/EmptyState.tsx
```tsx
import { memo, useCallback, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ViewStyle } from 'react-native';
import { EmptyState as BloomEmptyState, type EmptyStateAction } from '@oxy.so/bloom/empty-state';
import type { BloomIconComponent } from '@oxy.so/bloom';
import { RiRefreshLine } from '@oxy.so/bloom/icons/RiRefreshLine';
import type { EmptyStateStickerName } from '@/lib/stickers';
import { EmptyStateSticker } from '@/components/common/EmptyStateSticker';

export interface EmptyStateProps {
  title?: string;
  subtitle?: string;
  /** The Bloom glyph above the title. Bloom sizes it; an error draws a sticker instead. */
  icon?: BloomIconComponent;
  /** An error with a retry. The retrying state is this component's to hold. */
  error?: { title: string; message: string; onRetry?: () => Promise<void> };
  action?: EmptyStateAction;
  /** An arbitrary mark above the title. Wins over `icon`, as Bloom's does. */
  customIcon?: ReactNode;
  /**
   * A sticker from Oxy's catalogue above the title, by its name in
   * `lib/stickers.ts`. Wins over `icon` (Bloom's `illustration` does). With
   * `error` it defaults to `loadError`; a connection failure passes `offline`.
   */
  sticker?: EmptyStateStickerName;
  /** Below the action — a second, quieter way out (Bloom's `footer`). */
  footer?: ReactNode;
  containerStyle?: ViewStyle;
  testID?: string;
}

/**
 * Mention's empty and error states, drawn by Bloom.
 *
 * This used to hand-roll the block — a 72px disc, its own type ramp, its own
 * spacing, `accessibilityRole="text"` on a container holding three strings —
 * which is the shape `@oxy.so/bloom/empty-state` was added to replace across
 * the twelve Bloom families that had each drawn their own. What survives here
 * is only what is Mention's: the catalogue stickers, and the error/retry pair,
 * which Bloom models as an action with a `loading` flag rather than as a mode
 * of its own.
 */
export const EmptyState = memo<EmptyStateProps>(function EmptyState({
  title,
  subtitle,
  icon,
  error,
  action,
  customIcon,
  sticker,
  footer,
  containerStyle,
  testID,
}) {
  const { t } = useTranslation();
  const [isRetrying, setIsRetrying] = useState(false);
  const onRetry = error?.onRetry;

  const handleRetry = useCallback(async () => {
    if (!onRetry || isRetrying) return;
    setIsRetrying(true);
    try {
      await onRetry();
    } finally {
      setIsRetrying(false);
    }
  }, [onRetry, isRetrying]);

  if (error) {
    // Every failure gets a sticker: "could not load" unless the call site names
    // its own (`offline` for a connection failure). The tinted alarm disc stays
    // retired — a sticker is not an alarm, and a transient backend hiccup must
    // still read as a calm retry.
    return (
      <BloomEmptyState
        illustration={customIcon ?? <EmptyStateSticker name={sticker ?? 'loadError'} />}
        title={error.title}
        description={error.message}
        action={
          onRetry
            ? {
                label: t('common.retry', { defaultValue: 'Try again' }),
                onPress: handleRetry,
                icon: RiRefreshLine,
                loading: isRetrying,
              }
            : undefined
        }
        footer={footer}
        style={containerStyle}
        testID={testID}
      />
    );
  }

  if (!title && !subtitle && !customIcon && !icon && !sticker) return null;

  const illustration = customIcon ?? (sticker ? <EmptyStateSticker name={sticker} /> : undefined);

  return (
    <BloomEmptyState
      icon={icon}
      illustration={illustration}
      footer={footer}
      title={title}
      description={subtitle}
      action={action}
      style={containerStyle}
      testID={testID}
    />
  );
});

```

## packages/frontend/components/videos/InlineReplyComposer.tsx
```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Pressable, StyleSheet, type TextInputInstance } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxy.so/bloom/theme';
import { Divider } from '@oxy.so/bloom/divider';
import { RiSendPlaneLine } from '@oxy.so/bloom/icons/RiSendPlaneLine';
import { useSurfaceFill } from '@oxy.so/bloom/styles';
import { Textarea } from '@oxy.so/bloom/textarea';
import { toast } from '@oxy.so/bloom/toast';
import { logger } from '@oxy.so/core/logger';
import { usePostsStore } from '@/stores/postsStore';
import { usePublicationContinuation } from '@/hooks/usePublicationContinuation';

interface InlineReplyComposerProps {
  postId: string;
  /** Called after a reply successfully posts, so the caller can bump its own
   * local comment count (see Global Constraints — postsStore's optimistic
   * update does not reach the Videos screen's separate local state). */
  onPosted: () => void;
  /**
   * A CHANGE in this value takes the caret. Deliberately not a boolean: the
   * desktop comment button can be pressed twice in a row for the same video, and
   * both presses have to land.
   */
  focusNonce?: number;
}

/**
 * Minimal, text-only reply composer for the inline comments panel/sheet.
 * Deliberately narrower than the full `/compose` screen (no media, mentions,
 * or hashtags) — matches Reels' plain-text comment box.
 */
export function InlineReplyComposer({
  postId,
  onPosted,
  focusNonce = 0,
}: InlineReplyComposerProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  // This composer is pinned under a scrolling reply list on TWO different
  // surfaces — the right rail's panel and the video-replies bottom sheet — so
  // the colour it has to be opaque in is not the same one in both. `bg-card`
  // was the rail's answer given in the sheet too.
  const surfaceFill = useSurfaceFill();
  const createReply = usePostsStore((s) => s.createReply);
  const { capture, isMounted } = usePublicationContinuation();
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const editRevision = useRef(0);
  const activeSubmission = useRef<symbol | null>(null);
  const inputRef = useRef<TextInputInstance | null>(null);

  // Only a change taken while this composer was mounted counts. Seeding the ref
  // with the value at mount is what stops a remount — leaving /videos and coming
  // back — from stealing the caret on a nonce raised by a press long gone.
  const handledFocusNonceRef = useRef(focusNonce);
  useEffect(() => {
    if (handledFocusNonceRef.current === focusNonce) return;
    handledFocusNonceRef.current = focusNonce;
    inputRef.current?.focus();
  }, [focusNonce]);

  const handleSubmit = useCallback(async () => {
    const trimmed = text.trim();
    const isCurrentOwner = capture();
    if (!trimmed || submitting || activeSubmission.current) return;
    if (!isCurrentOwner) {
      toast(t('common.error', { defaultValue: 'Something went wrong' }), { type: 'error' });
      return;
    }
    const revision = editRevision.current;
    const operation = Symbol('reply');
    activeSubmission.current = operation;
    setSubmitting(true);
    let confirmed = false;
    const warnUnconfirmed = () =>
      toast(
        t('compose.replyUnconfirmed', {
          defaultValue: 'Could not confirm your reply. Check the conversation before trying again.',
        }),
        { type: 'error' },
      );
    try {
      await createReply({ postId, content: { text: trimmed } });
      confirmed = true;
      if (!isCurrentOwner()) {
        if (capture()) warnUnconfirmed();
        return;
      }
      if (editRevision.current === revision) setText('');
      onPosted();
    } catch (error) {
      if (confirmed) {
        logger.error('Reply posted, but updating the conversation failed', error);
      } else if (isCurrentOwner() || capture()) {
        warnUnconfirmed();
      }
    } finally {
      if (activeSubmission.current === operation) {
        activeSubmission.current = null;
        if (isMounted()) setSubmitting(false);
      }
    }
  }, [text, submitting, createReply, postId, onPosted, t, capture, isMounted]);

  return (
    <>
      <Divider />
      <View style={[styles.row, { backgroundColor: surfaceFill }]}>
        <Textarea
          inputRef={inputRef}
          value={text}
          onChangeText={(value) => {
            editRevision.current += 1;
            setText(value);
          }}
          placeholder={t('videos.addComment')}
          size="sm"
          rows={1}
          autoResize
          maxRows={5}
          maxLength={2000}
          style={styles.input}
        />
        <Pressable
          onPress={handleSubmit}
          disabled={!text.trim() || submitting}
          style={styles.sendButton}
          accessibilityRole="button"
          accessibilityLabel={t('common.send', { defaultValue: 'Send' })}
        >
          <RiSendPlaneLine
            size="md"
            fill={text.trim() && !submitting ? theme.colors.primary : theme.colors.textSecondary}
          />
        </Pressable>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  input: {
    flex: 1,
  },
  sendButton: {
    paddingBottom: 8,
    paddingHorizontal: 4,
  },
});

```

## packages/frontend/components/videos/VideoReplies.tsx
```tsx
import { Screen } from '@oxy.so/bloom/screen';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { IconButton } from '@oxy.so/bloom/button';
import { useTranslation } from 'react-i18next';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import Feed from '@/components/Feed/Feed';
import { useVideosRail } from '@/context/VideosRailContext';
import { InlineReplyComposer } from './InlineReplyComposer';

export interface VideoRepliesProps {
  postId: string;
  /**
   * Omitted on desktop — the replies column (RightBar) is always open and
   * cannot be dismissed. Only the mobile bottom sheet passes this to close
   * itself.
   */
  onClose?: () => void;
  /** Called after a reply successfully posts — see InlineReplyComposer. */
  onCommentPosted: () => void;
}

/**
 * Shared replies list + composer content, presented inside the mobile bottom
 * sheet (toggled by the on-video comment button) and the always-open desktop
 * replies column (rendered inside `RightBar`, next to the videos rail).
 * Bloom owns chrome and scroll; Feed virtualizes against that same viewport.
 */
export function VideoReplies({ postId, onClose, onCommentPosted }: VideoRepliesProps) {
  const { t } = useTranslation();
  // Desktop's on-video comment button opens nothing (this column is already
  // there) — it takes the caret instead. The mobile sheet never bumps the nonce,
  // so its composer is unaffected.
  const { focusComposerNonce } = useVideosRail();

  return (
    <Screen
      scroll="auto"
      documentScroll={onClose ? false : undefined}
      header={
        <PageHeader
          title={t('videos.replies')}
          actions={
            onClose ? (
              <IconButton
                leadingIcon={RiCloseLine}
                onPress={onClose}
                accessibilityLabel={t('common.close', { defaultValue: 'Close' })}
              />
            ) : undefined
          }
        />
      }
      bottomBar={
        <InlineReplyComposer
          postId={postId}
          onPosted={onCommentPosted}
          focusNonce={focusComposerNonce}
        />
      }
    >
      <Feed type="replies" filters={{ postId, parentPostId: postId }} hideHeader />
    </Screen>
  );
}

```