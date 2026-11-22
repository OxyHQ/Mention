import { useLocalSearchParams } from '@/lib/navigation/router';
import type React from 'react';
import { useState, useRef, useEffect } from 'react';
import {
  View,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  type TextInputInstance,
  type ViewStyle,
} from 'react-native';
import { toast } from '@oxy.so/bloom/toast';
import { Dialog, useDialogControl } from '@oxy.so/bloom/dialog';
import { AccountAvatar } from '@/components/ui/AccountAvatar';
import { Screen, useScreenBack } from '@oxy.so/bloom/screen';
import { RiRepeat2Line } from '@oxy.so/bloom/icons/RiRepeat2Line';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import type { CreateBoostRequest } from '@mention/shared-types/feed';
import type { FeedItem } from '@/db';
import PostContentText from '@/components/Post/PostContentText';
import UserName from './UserName';

import { useContentSafeAreaInsets } from '@oxy.so/bloom/layout';
import { useAuth } from '@oxy.so/services/ui/client';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { usePostsStore } from '../stores/postsStore';
import { useTheme } from '@oxy.so/bloom/theme';
import { useTranslation } from 'react-i18next';
import { logger } from '@oxy.so/core/logger';
import {
  Divider as LDivider,
  Embed,
  HStack,
  Icon,
  RawText,
  ScrollView,
  VStack,
  defineTokens,
  toElement,
} from '@oxy.so/bloom-language';

/** "Post not found" sits 100pt down the empty screen. */
const boost = defineTokens({ space: { notFoundTop: 100 } });

// What the screen's classes drew, as plain objects (inline, as the classes were).
const FILL_STYLE: ViewStyle = { flexGrow: 1, flexShrink: 1, flexBasis: '0%' };
const HEADER_ROW_STYLE: ViewStyle = {
  flexDirection: 'row',
  justifyContent: 'space-between',
  alignItems: 'center',
  paddingHorizontal: 16,
  paddingBottom: 12,
};
const CANCEL_STYLE: ViewStyle = { paddingVertical: 8, paddingHorizontal: 12 };
/** The Boost pill: 20pt by 8pt inside a full radius. */
const BOOST_BUTTON_STYLE: ViewStyle = {
  borderRadius: Number.MAX_SAFE_INTEGER,
  paddingHorizontal: 20,
  paddingVertical: 8,
};

const MAX_CHARACTERS = 280;

const BoostScreen: React.FC = () => {
  const { user } = useAuth();
  const { id: postId } = useLocalSearchParams<{ id: string }>();
  const insets = useContentSafeAreaInsets();
  const theme = useTheme();
  const { t } = useTranslation();
  const back = useScreenBack();

  const [content, setContent] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const discardControl = useDialogControl();
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
      discardControl.open();
    } else {
      back?.();
    }
  };

  if (!originalPost) {
    return toElement(
      VStack(
        RawText('Post not found')
          .font('18')
          .leading('28px')
          .textAlign('center')
          .margin('top', boost.space.notFoundTop),
      ).flex('1'),
    );
  }

  return (
    <KeyboardAvoidingView
      style={FILL_STYLE}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <Screen
        header={toElement(
          VStack(
            // A View: its top pad is the safe area's, a number known only as it renders.
            Embed((render) => (
              <View style={[HEADER_ROW_STYLE, { paddingTop: insets.top }]}>
                <TouchableOpacity onPress={handleCancel} style={CANCEL_STYLE}>
                  {render(
                    RawText('Cancel')
                      .foreground('primary')
                      .font('16')
                      .leading('normal')
                      .weight('semibold'),
                  )}
                </TouchableOpacity>

                {render(
                  HStack(
                    Embed(
                      <TouchableOpacity
                        style={[BOOST_BUTTON_STYLE, !canBoost && { opacity: 0.5 }]}
                        onPress={handleBoost}
                        disabled={!canBoost}
                      >
                        {render(canBoost ? boostLabel : boostLabel.opacity('70'))}
                      </TouchableOpacity>,
                    ),
                  ).align('center'),
                )}
              </View>
            )),
            LDivider(),
          ).background('background'),
        )}
      >
        {toElement(
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
                  Embed(
                    <UserName
                      name={originalPost.user.name?.displayName}
                      handle={getNormalizedUserHandle(originalPost.user) ?? undefined}
                      verified={originalPost.user.verified}
                      variant="small"
                      style={{ handle: { fontSize: 13 } }}
                    />,
                  ),
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
        )}
      </Screen>
      <Dialog
        control={discardControl}
        title="Discard Boost?"
        description="Are you sure you want to discard this boost?"
        actions={[
          {
            label: 'Discard',
            color: 'destructive',
            onPress: () => back?.(),
          },
          {
            label: 'Keep Editing',
            color: 'cancel',
          },
        ]}
      />
    </KeyboardAvoidingView>
  );
};

export default BoostScreen;
