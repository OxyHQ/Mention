import { useLocalSearchParams } from '@/lib/navigation/router';
import { useState, useRef, useEffect } from 'react';
import { TextInput, type TextInputInstance } from 'react-native';
import { toast } from '@oxy.so/bloom/toast';
import { AccountAvatar } from '@/components/ui/AccountAvatar';
import { useScreenBack } from '@oxy.so/bloom/screen';
import { RiRepeat2Line } from '@oxy.so/bloom/icons/RiRepeat2Line';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import type { CreateBoostRequest } from '@mention/shared-types/feed';
import type { FeedItem } from '@/db';
import PostContentText from '@/components/Post/PostContentText';
import UserName from './UserName';

import { useAuth } from '@oxy.so/services/ui/client';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { usePostsStore } from '../stores/postsStore';
import { useTheme } from '@oxy.so/bloom/theme';
import { useTranslation } from 'react-i18next';
import { logger } from '@oxy.so/core/logger';
import {
  Dialog,
  Divider as LDivider,
  Embed,
  Group,
  HStack,
  Icon,
  RawText,
  ScrollView,
  VStack,
  defineTokens,
  defineModifier,
} from '@oxy.so/bloom-language';
import { screen } from '@oxy.so/bloom-language/router';

/** The boosted post's handle, at 13pt. */
const SMALL_HANDLE = defineModifier((v) => v.font('sm'));

/** "Post not found" sits 100pt down the empty screen. */
const boost = defineTokens({ space: { notFoundTop: 100 } });

const MAX_CHARACTERS = 280;

export default screen(function BoostScreen() {
  const { user } = useAuth();
  const { id: postId } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const { t } = useTranslation();
  const back = useScreenBack();

  const [content, setContent] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [originalPost, setOriginalPost] = useState<FeedItem | null>(null);
  const textInputRef = useRef<TextInputInstance>(null);

  const getPostById = usePostsStore((state) => state.getPostById);
  const createBoost = usePostsStore((state) => state.createBoost);

  useEffect(() => {
    const loadOriginal = async () => {
      try {
        if (!postId) return;
        // Try from SQLite cache first
        const found = usePostsStore.getState().getPostFromDb(postId);
        if (found) setOriginalPost(found);
        else {
          const fetched = await getPostById(String(postId));
          setOriginalPost(fetched);
        }
      } catch {
        logger.error('Failed to load original post for boost');
      }
    };
    loadOriginal();
  }, [postId, getPostById]);

  const characterCount = content.length;
  const isOverLimit = characterCount > MAX_CHARACTERS;
  const canBoost = !isOverLimit && !isSubmitting;
  // The label fades with the pill while a boost cannot be sent.
  const boostLabel = RawText(isSubmitting ? 'Boosting...' : 'Boost')
    .font('16')
    .leading('normal')
    .weight('bold');

  const handleBoost = async () => {
    if (!canBoost || !user || !originalPost || !postId) return;

    setIsSubmitting(true);

    try {
      // Create boost request
      const boostRequest: CreateBoostRequest = {
        originalPostId: postId,
        content: content.trim() ? { text: content.trim() } : undefined,
        mentions: [],
        hashtags: [],
      };

      // Add to backend and store using posts store
      await createBoost(boostRequest);

      // Navigate back
      back?.();

      // Show success feedback
      toast('Post boosted successfully!', { type: 'success' });
    } catch {
      logger.error('Error boosting');
      toast('Failed to boost. Please try again.', { type: 'error' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = () => {
    if (content.trim().length > 0) {
      setDiscarding(true);
    } else {
      back?.();
    }
  };

  // A Screen of no header, scroll or footer: its fill (the page's) and its
  // content box flush with the route, so the text sits where it did.
  if (!originalPost) {
    return VStack(
      RawText('Post not found')
        .font('18')
        .leading('28px')
        .textAlign('center')
        .margin('top', boost.space.notFoundTop),
    )
      .flex('1')
      .header(false)
      .screenScroll('none');
  }

  // The discard dialog draws nothing in place (an alert over the app).
  return Group(
    ScrollView(
      /* Boost Header */ HStack(
        Icon(RiRepeat2Line).size('md').foreground('primary'),
        RawText('Boost')
          .foreground('primary')
          .font('16')
          .leading('normal')
          .weight('semibold')
          .margin('left', 'sm'),
      )
        .padding('vertical', 'md')
        .align('center'),
      LDivider(),
      /* Original Post */ VStack(
        HStack(
          Embed(
            <AccountAvatar
              account={originalPost.user}
              source={originalPost.user.avatar ?? undefined}
              size={32}
              variant={MEDIA_VARIANT_AVATAR}
              style={{ marginRight: 8 }}
            />,
          ),
          VStack(
            UserName({
              name: originalPost.user.name?.displayName,
              handle: getNormalizedUserHandle(originalPost.user) ?? undefined,
              verified: originalPost.user.verified,
              size: 'sm',
              handleLook: SMALL_HANDLE,
            }),
          ).flex('1'),
        )
          .align('center')
          .margin('bottom', 'sm'),
        Embed(
          <PostContentText
            content={originalPost.content}
            postId={originalPost.id}
            previewChars={Infinity}
          />,
        ),
      )
        .padding('vertical', 'lg')
        .margin('top', 'lg'),
      LDivider(),
      /* Boost Input */ VStack(
        HStack(
          Embed(
            <AccountAvatar
              account={user ?? undefined}
              source={user?.avatar}
              size={48}
              variant={MEDIA_VARIANT_AVATAR}
              style={{ marginRight: 12 }}
            />,
          ),
          VStack(
            RawText(user?.name.displayName)
              .foreground('foreground')
              .font('16')
              .leading('normal')
              .weight('bold')
              .margin('bottom', '2xs'),
            RawText('@', user?.username).foreground('muted').font('14').leading('20px'),
          ).justify('center'),
        ).margin('bottom', 'md'),
        Embed(
          <TextInput
            ref={textInputRef}
            style={{
              fontSize: 20,
              lineHeight: 28,
              minHeight: 120,
              textAlignVertical: 'top',
              color: theme.colors.text,
            }}
            placeholder={t('compose.commentPlaceholder')}
            placeholderTextColor={theme.colors.textTertiary}
            value={content}
            onChangeText={setContent}
            multiline
            autoFocus
            maxLength={MAX_CHARACTERS + 50}
            textAlignVertical="top"
          />,
        ),
        /* Character Count */ HStack(
          RawText(characterCount)
            .font('14')
            .leading('20px')
            .weight('medium')
            .foreground(isOverLimit ? 'error' : 'muted'),
          RawText('/', MAX_CHARACTERS)
            .foreground('muted')
            .font('14')
            .leading('20px')
            .margin('left', '2xs'),
        )
          .justify('end')
          .align('center')
          .margin('top', 'lg')
          .margin('bottom', 'xl'),
      )
        .flex('1')
        .margin('top', 'lg'),
    )
      .contentView((v) => v.padding('horizontal', 'lg'))
      .scrollIndicators('hidden', 'vertical'),
    Dialog()
      .title('Discard Boost?')
      .message('Are you sure you want to discard this boost?')
      .buttons([
        {
          label: 'Discard',
          color: 'destructive',
          onPress: () => back?.(),
        },
        {
          label: 'Keep Editing',
          color: 'cancel',
        },
      ])
      .presented([discarding, setDiscarding]),
  )
    .header(
      VStack(
        HStack(
          VStack(
            RawText('Cancel').foreground('primary').font('16').leading('normal').weight('semibold'),
          )
            .padding('vertical', 'sm')
            .padding('horizontal', 'md')
            .onPress(handleCancel)
            .pressFade(),
          HStack(
            VStack(canBoost ? boostLabel : boostLabel.opacity('70'))
              .padding('horizontal', 'xl')
              .padding('vertical', 'sm')
              .corner('infinite')
              .when(!canBoost, (v) => v.opacity('half'))
              .onPress(handleBoost)
              .disabled(!canBoost)
              .pressFade(),
          ).align('center'),
        )
          .padding('horizontal', 'lg')
          .padding('bottom', 'md')
          // The content's top inset: what the frame around the screen left of the device's.
          .safeAreaPadding('top', 'content')
          .justify('between')
          .align('center'),
        LDivider(),
      ).background('background'),
    )
    .keyboardAvoiding('1');
});
