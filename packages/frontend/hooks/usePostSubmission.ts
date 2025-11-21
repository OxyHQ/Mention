import { useState, useCallback, useRef } from 'react';
import { MentionData } from '@/components/MentionTextInput';
import { GeoJSONPoint } from '@mention/shared-types';
import { buildAttachmentsPayload } from '@/utils/attachmentsUtils';
import {
  ComposerMediaItem,
  POLL_ATTACHMENT_KEY,
  LOCATION_ATTACHMENT_KEY,
  createMediaAttachmentKey,
} from '@/utils/composeUtils';

interface ThreadItem {
  id: string;
  text: string;
  mentions?: MentionData[];
  mediaIds: ComposerMediaItem[];
  pollTitle?: string;
  pollOptions: string[];
  location?: {
    latitude: number;
    longitude: number;
    address?: string;
  } | null;
}

interface PostSubmissionProps {
  user: any;
  postContent: string;
  mentions: MentionData[];
  mediaIds: ComposerMediaItem[];
  pollTitle: string;
  pollOptions: string[];
  article: any;
  hasArticleContent: boolean;
  event: any;
  hasEventContent: boolean;
  location: any;
  sources: any[];
  attachmentOrder: string[];
  threadItems: ThreadItem[];
  postingMode: 'thread' | 'beast';
  replyPermission: string;
  reviewReplies: boolean;
  scheduledAt: Date | null;
  scheduleEnabled: boolean;
  sanitizeSourcesForSubmit: (sources: any[]) => any[];
  createPost: (post: any) => Promise<any>;
  createThread: (thread: any) => Promise<any>;
  deleteDraft: (draftId: string) => Promise<void>;
  currentDraftId: string | null;
  setCurrentDraftId: (id: string | null) => void;
  clearSchedule: (options?: { silent?: boolean }) => void;
  onSuccess: () => void;
}

export const usePostSubmission = ({
  user,
  postContent,
  mentions,
  mediaIds,
  pollTitle,
  pollOptions,
  article,
  hasArticleContent,
  event,
  hasEventContent,
  location,
  sources,
  attachmentOrder,
  threadItems,
  postingMode,
  replyPermission,
  reviewReplies,
  scheduledAt,
  scheduleEnabled,
  sanitizeSourcesForSubmit,
  createPost,
  createThread,
  deleteDraft,
  currentDraftId,
  setCurrentDraftId,
  clearSchedule,
  onSuccess,
}: PostSubmissionProps) => {
  const [isPosting, setIsPosting] = useState(false);
  
  // Refs to ensure we have the latest values
  const attachmentOrderRef = useRef(attachmentOrder);
  const scheduledAtRef = useRef(scheduledAt);

  // Update refs
  attachmentOrderRef.current = attachmentOrder;
  scheduledAtRef.current = scheduledAt;

  const validatePost = useCallback(() => {
    const hasText = postContent.trim().length > 0;
    const hasMedia = mediaIds.length > 0;
    const hasPoll = pollOptions.length > 0 && pollOptions.some(opt => opt.trim().length > 0);
    
    return hasText || hasMedia || hasPoll || hasArticleContent || hasEventContent;
  }, [postContent, mediaIds, pollOptions, hasArticleContent]);

  const buildMainPost = useCallback(() => {
    const formattedSources = sanitizeSourcesForSubmit(sources);
    const hasPoll = pollOptions.length > 0 && pollOptions.some(opt => opt.trim().length > 0);
    
    const attachmentsPayload = buildAttachmentsPayload(
      attachmentOrderRef.current || attachmentOrder,
      mediaIds,
      {
        includePoll: hasPoll,
        includeArticle: Boolean(hasArticleContent && article),
        includeEvent: Boolean(hasEventContent && event),
        includeLocation: Boolean(location),
        includeSources: formattedSources.length > 0,
      }
    );

    const articlePayload = hasArticleContent && article ? {
      ...(article.title?.trim() ? { title: article.title.trim() } : {}),
      ...(article.body?.trim() ? { body: article.body.trim() } : {}),
    } : undefined;

    const eventPayload = hasEventContent && event ? {
      name: event.name.trim(),
      date: event.date,
      ...(event.location?.trim() && { location: event.location.trim() }),
      ...(event.description?.trim() && { description: event.description.trim() }),
    } : undefined;

    if (__DEV__ && hasEventContent) {
      console.log('[PostSubmission] Event data:', event);
      console.log('[PostSubmission] Event payload:', eventPayload);
      console.log('[PostSubmission] hasEventContent:', hasEventContent);
    }

    const wasScheduled = Boolean(scheduledAtRef.current);

    return {
      content: {
        text: postContent.trim(),
        media: mediaIds.map(m => ({ id: m.id, type: m.type })),
        ...(hasPoll && {
          poll: {
            question: pollTitle.trim() || postContent.trim() || 'Poll',
            options: pollOptions.filter(opt => opt.trim().length > 0),
            endTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
            votes: {},
            userVotes: {}
          }
        }),
        ...(location && {
          location: {
            type: 'Point' as const,
            coordinates: [location.longitude, location.latitude],
            address: location.address
          } as GeoJSONPoint
        }),
        ...(formattedSources.length > 0 && { sources: formattedSources }),
        ...(articlePayload && { article: articlePayload }),
        ...(eventPayload && { event: eventPayload }),
        ...(attachmentsPayload.length > 0 && { attachments: attachmentsPayload })
      },
      mentions: mentions.map(m => m.userId),
      hashtags: [],
      replyPermission: replyPermission,
      reviewReplies: reviewReplies,
      ...(wasScheduled && scheduledAtRef.current ? {
        status: 'scheduled' as const,
        scheduledFor: scheduledAtRef.current.toISOString()
      } : {})
    };
  }, [
    postContent,
    mentions,
    mediaIds,
    pollTitle,
    pollOptions,
    article,
    hasArticleContent,
    location,
    sources,
    attachmentOrder,
    replyPermission,
    reviewReplies,
    sanitizeSourcesForSubmit,
  ]);

  const buildThreadPosts = useCallback(() => {
    const posts: any[] = [];

    threadItems.forEach(item => {
      if (item.text.trim().length > 0 || item.mediaIds.length > 0 ||
        (item.pollOptions.length > 0 && item.pollOptions.some(opt => opt.trim().length > 0))) {
        const threadHasPoll = item.pollOptions.length > 0 && item.pollOptions.some(opt => opt.trim().length > 0);
        const threadHasLocation = Boolean(item.location);
        const threadOrder: string[] = [];
        
        if (threadHasPoll) threadOrder.push(POLL_ATTACHMENT_KEY);
        item.mediaIds.forEach((media) => {
          threadOrder.push(createMediaAttachmentKey(media.id));
        });
        if (threadHasLocation) threadOrder.push(LOCATION_ATTACHMENT_KEY);

        const threadAttachmentsPayload = buildAttachmentsPayload(threadOrder, item.mediaIds, {
          includePoll: threadHasPoll,
          includeArticle: false,
          includeLocation: threadHasLocation,
          includeSources: false,
        });

        posts.push({
          content: {
            text: item.text.trim(),
            media: item.mediaIds.map(m => ({ id: m.id, type: m.type })),
            ...(item.pollOptions.length > 0 && item.pollOptions.some(opt => opt.trim().length > 0) && {
              poll: {
                question: (item.pollTitle && item.pollTitle.trim()) || item.text.trim() || 'Poll',
                options: item.pollOptions.filter(opt => opt.trim().length > 0),
                endTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
                votes: {},
                userVotes: {}
              }
            }),
            ...(item.location && {
              location: {
                type: 'Point' as const,
                coordinates: [item.location.longitude, item.location.latitude],
                address: item.location.address
              } as GeoJSONPoint
            }),
            ...(threadAttachmentsPayload.length > 0 && { attachments: threadAttachmentsPayload })
          },
          mentions: item.mentions?.map(m => m.userId) || [],
          hashtags: [],
          replyPermission: replyPermission,
          reviewReplies: reviewReplies
        });
      }
    });

    return posts;
  }, [threadItems, replyPermission, reviewReplies]);

  const handlePost = useCallback(async (t: any) => {
    if (isPosting || !user) return { success: false };
    
    if (scheduledAt && !scheduleEnabled) {
      return { success: false, error: 'schedule.threadsUnsupported' };
    }

    if (!validatePost()) {
      return { success: false, error: 'validation.emptyPost' };
    }

    setIsPosting(true);
    try {
      console.log('Attempting to create posts...');

      const allPosts = [];
      const mainPost = buildMainPost();
      allPosts.push(mainPost);

      const threadPosts = buildThreadPosts();
      allPosts.push(...threadPosts);

      console.log(`📝 Creating ${allPosts.length} posts in ${postingMode} mode`);

      if (allPosts.length === 1) {
        await createPost(allPosts[0] as any);
      } else {
        await createThread({
          mode: postingMode,
          posts: allPosts
        });
      }

      if (currentDraftId) {
        await deleteDraft(currentDraftId);
        setCurrentDraftId(null);
      }

      const wasScheduled = Boolean(scheduledAtRef.current);
      clearSchedule({ silent: true });
      onSuccess();

      return { 
        success: true, 
        wasScheduled,
        scheduledAt: scheduledAtRef.current 
      };
    } catch (error) {
      console.error('Error creating post:', error);
      return { success: false, error: 'submission.failed' };
    } finally {
      setIsPosting(false);
    }
  }, [
    isPosting,
    user,
    scheduledAt,
    scheduleEnabled,
    validatePost,
    buildMainPost,
    buildThreadPosts,
    postingMode,
    createPost,
    createThread,
    currentDraftId,
    deleteDraft,
    setCurrentDraftId,
    clearSchedule,
    onSuccess,
  ]);

  return {
    isPosting,
    handlePost,
  };
};
