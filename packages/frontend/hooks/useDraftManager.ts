import { useState, useCallback, useRef, useEffect } from 'react';
import { MentionData } from '@/components/MentionTextInput';
import {
  ComposerMediaItem,
  toComposerMediaType,
  POLL_ATTACHMENT_KEY,
  ARTICLE_ATTACHMENT_KEY,
  LOCATION_ATTACHMENT_KEY,
  SOURCES_ATTACHMENT_KEY,
  createMediaAttachmentKey,
} from '@/utils/composeUtils';

interface DraftManagerProps {
  saveDraft: (draft: any) => Promise<string>;
  deleteDraft: (draftId: string) => Promise<void>;
  onDraftLoad: (draft: {
    postContent: string;
    mediaIds: ComposerMediaItem[];
    pollOptions: string[];
    pollTitle: string;
    showPollCreator: boolean;
    location: any;
    sources: any[];
    article: any;
    articleDraftTitle: string;
    articleDraftBody: string;
    scheduledAt: Date | null;
    attachmentOrder: string[];
    mentions: MentionData[];
    postingMode: 'thread' | 'beast';
    threadItems: any[];
  }) => void;
}

export const useDraftManager = ({
  saveDraft,
  deleteDraft,
  onDraftLoad,
}: DraftManagerProps) => {
  const [currentDraftId, setCurrentDraftId] = useState<string | null>(null);
  const autoSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const buildDraftData = useCallback((refs: {
    postContent: string;
    mediaIds: ComposerMediaItem[];
    pollOptions: string[];
    pollTitle: string;
    showPollCreator: boolean;
    location: any;
    sources: any[];
    article: any;
    threadItems: any[];
    mentions: MentionData[];
    postingMode: 'thread' | 'beast';
    attachmentOrder: string[];
    scheduledAt: Date | null;
    currentDraftId: string | null;
  }) => {
    const shouldShowPollCreator = refs.showPollCreator || 
      (refs.pollOptions.length > 0 && refs.pollOptions.some(opt => opt.trim().length > 0));

    return {
      id: refs.currentDraftId || undefined,
      postContent: refs.postContent,
      mediaIds: refs.mediaIds.map(m => ({ id: m.id, type: m.type })),
      pollOptions: refs.pollOptions || [],
      pollTitle: refs.pollTitle || '',
      showPollCreator: shouldShowPollCreator,
      location: refs.location ? {
        latitude: refs.location.latitude,
        longitude: refs.location.longitude,
        address: refs.location.address,
      } : null,
      sources: refs.sources.map((source) => ({ 
        id: source.id, 
        title: source.title, 
        url: source.url 
      })),
      article: refs.article ? {
        ...(refs.article.title ? { title: refs.article.title } : {}),
        ...(refs.article.body ? { body: refs.article.body } : {}),
      } : undefined,
      threadItems: refs.threadItems.map(item => ({
        id: item.id,
        text: item.text,
        mediaIds: item.mediaIds.map((m: ComposerMediaItem) => ({ id: m.id, type: m.type })),
        pollOptions: item.pollOptions || [],
        pollTitle: item.pollTitle || '',
        showPollCreator: item.showPollCreator || 
          (item.pollOptions && item.pollOptions.length > 0 && 
           item.pollOptions.some((opt: string) => opt.trim().length > 0)),
        location: item.location ? {
          latitude: item.location.latitude,
          longitude: item.location.longitude,
          address: item.location.address,
        } : null,
        mentions: item.mentions.map((m: MentionData) => ({
          userId: m.userId,
          handle: m.username,
          name: m.displayName,
        })),
      })),
      mentions: refs.mentions.map(m => ({
        userId: m.userId,
        handle: m.username,
        name: m.displayName,
      })),
      postingMode: refs.postingMode,
      attachmentOrder: refs.attachmentOrder,
      scheduledAt: refs.scheduledAt ? refs.scheduledAt.toISOString() : null,
    };
  }, []);

  const hasContent = useCallback((refs: {
    postContent: string;
    mediaIds: ComposerMediaItem[];
    pollOptions: string[];
    location: any;
    article: any;
    sources: any[];
    threadItems: any[];
  }) => {
    return refs.postContent.trim().length > 0 ||
      refs.mediaIds.length > 0 ||
      (refs.pollOptions.length > 0 && refs.pollOptions.some(opt => opt.trim().length > 0)) ||
      refs.location ||
      (refs.article && ((refs.article.title && refs.article.title.trim().length > 0) || 
                        (refs.article.body && refs.article.body.trim().length > 0))) ||
      refs.sources.some(source => (source.title && source.title.trim().length > 0) || 
                                   (source.url && source.url.trim().length > 0)) ||
      refs.threadItems.some(item => item.text.trim().length > 0 || item.mediaIds.length > 0 ||
        (item.pollOptions.length > 0 && item.pollOptions.some((opt: string) => opt.trim().length > 0)) || 
        item.location);
  }, []);

  const autoSave = useCallback(async (refs: any) => {
    if (!hasContent(refs)) {
      if (refs.currentDraftId) {
        await deleteDraft(refs.currentDraftId);
        setCurrentDraftId(null);
      }
      return;
    }

    try {
      const draftData = buildDraftData(refs);
      const draftId = await saveDraft(draftData);
      setCurrentDraftId(draftId);
    } catch (error) {
      console.error('Error auto-saving draft:', error);
    }
  }, [hasContent, buildDraftData, saveDraft, deleteDraft]);

  const loadDraft = useCallback((draft: any) => {
    const mediaIdsData = (draft.mediaIds || []).map((m: any) => ({
      id: m.id || m,
      type: toComposerMediaType(m.type, m.mime || m.contentType),
    })).filter((m: any) => m.id);

    const pollOpts = draft.pollOptions || [];
    const shouldShowPoll = draft.showPollCreator || pollOpts.length > 0;

    let locationData = null;
    if (draft.location) {
      locationData = {
        latitude: draft.location.latitude,
        longitude: draft.location.longitude,
        address: draft.location.address || null,
      };
    }

    const sourcesData = (draft.sources || []).map((source: any) => ({
      id: source.id || '',
      title: source.title || '',
      url: source.url || '',
    }));

    let articleData = null;
    let articleDraftTitle = '';
    let articleDraftBody = '';
    if (draft.article && (draft.article.title || draft.article.body)) {
      articleData = {
        title: draft.article.title || '',
        body: draft.article.body || '',
      };
      articleDraftTitle = draft.article.title || '';
      articleDraftBody = draft.article.body || '';
    }

    let scheduledAtData: Date | null = null;
    if (draft.scheduledAt) {
      const parsed = new Date(draft.scheduledAt);
      if (!Number.isNaN(parsed.getTime())) {
        scheduledAtData = parsed;
      }
    }

    // Build attachment order
    const availableAttachmentKeys: string[] = [];
    if (shouldShowPoll) {
      availableAttachmentKeys.push(POLL_ATTACHMENT_KEY);
    }
    if (articleData) {
      availableAttachmentKeys.push(ARTICLE_ATTACHMENT_KEY);
    }
    if (locationData) {
      availableAttachmentKeys.push(LOCATION_ATTACHMENT_KEY);
    }
    if (sourcesData.some((source: any) => source.url.trim().length > 0)) {
      availableAttachmentKeys.push(SOURCES_ATTACHMENT_KEY);
    }
    mediaIdsData.forEach((media: ComposerMediaItem) => {
      availableAttachmentKeys.push(createMediaAttachmentKey(media.id));
    });

    const draftAttachmentOrder = Array.isArray(draft.attachmentOrder) ? draft.attachmentOrder : [];
    const sanitizedAttachmentOrder: string[] = [];
    draftAttachmentOrder.forEach((key: string) => {
      if (availableAttachmentKeys.includes(key)) {
        sanitizedAttachmentOrder.push(key);
      }
    });
    availableAttachmentKeys.forEach(key => {
      if (!sanitizedAttachmentOrder.includes(key)) {
        sanitizedAttachmentOrder.push(key);
      }
    });

    const mentionsData = (draft.mentions || []).map((m: any) => ({
      userId: m.userId,
      username: m.handle,
      displayName: m.name,
    }));

    const threadItemsData = (draft.threadItems || []).map((item: any) => ({
      ...item,
      mediaIds: (item.mediaIds || []).map((m: any) => ({
        id: m.id || m,
        type: toComposerMediaType(m.type, m.mime || m.contentType),
      })).filter((m: any) => m.id),
      mentions: (item.mentions || []).map((m: any) => ({
        userId: m.userId,
        username: m.handle,
        displayName: m.name,
      })),
    }));

    onDraftLoad({
      postContent: draft.postContent || '',
      mediaIds: mediaIdsData,
      pollOptions: pollOpts,
      pollTitle: draft.pollTitle || '',
      showPollCreator: shouldShowPoll,
      location: locationData,
      sources: sourcesData,
      article: articleData,
      articleDraftTitle,
      articleDraftBody,
      scheduledAt: scheduledAtData,
      attachmentOrder: sanitizedAttachmentOrder,
      mentions: mentionsData,
      postingMode: draft.postingMode || 'thread',
      threadItems: threadItemsData,
    });

    setCurrentDraftId(draft.id);
  }, [onDraftLoad]);

  return {
    currentDraftId,
    setCurrentDraftId,
    autoSaveTimeoutRef,
    autoSave,
    loadDraft,
  };
};
