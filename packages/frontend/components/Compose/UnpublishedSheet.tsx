import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import { toast } from '@oxy.so/bloom/toast';
import { createLogger } from '@oxy.so/core/logger';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import type { HydratedPost } from '@mention/shared-types';
import type { Draft } from '@/hooks/useDrafts';
import { useScheduledPosts } from '@/hooks/useScheduledPosts';
import { useServerDrafts } from '@/hooks/useServerDrafts';
import DraftsList from './DraftsList';
import ScheduledPostsList from './ScheduledPostsList';
import ScheduledPostPreview from './ScheduledPostPreview';
import ServerDraftPreview from './ServerDraftPreview';
import DraftPreview from './DraftPreview';

import {
  Button as LButton,
  Embed,
  HStack,
  Header,
  Icon,
  RawText,
  VStack,
  defineTokens,
  toElement,
  type Child,
} from '@oxy.so/bloom-language';

const logger = createLogger('UnpublishedSheet');

/** The sheet stops growing at 600pt (`max-h-[600px]`). */
const sheetTokens = defineTokens({ space: { maxHeight: 600 } });
/** The sheet: its header, tabs and body, or a preview in their place. */
const unpublishedSheet = (...children: Child[]) =>
  VStack(...children)
    .flex('1')
    .frame({ maxHeight: sheetTokens.space.maxHeight })
    .background('background');

type UnpublishedTab = 'drafts' | 'scheduled';

interface UnpublishedSheetProps {
  onClose: () => void;
  onLoadDraft: (draft: Draft) => void | Promise<void>;
  currentDraftId: string | null;
}

interface TabButtonProps {
  label: string;
  count?: number;
  isActive: boolean;
  onPress: () => void;
}

const TabButton: React.FC<TabButtonProps> = ({ label, count, isActive, onPress }) =>
  toElement(
    HStack(
      RawText(label)
        .font('md')
        .weight('semibold')
        .foreground(isActive ? 'primary' : 'muted'),
      count !== undefined && count > 0
        ? VStack(
            RawText(count)
              .font('11')
              .weight('semibold')
              .foreground(isActive ? 'card' : 'muted'),
          )
            .padding('horizontal', '6')
            .padding('vertical', '2xs')
            .frame({ minWidth: 'xl' })
            .background(isActive ? 'primary' : 'border')
            .corner('infinite')
            .align('center')
        : null,
    )
      .flex('1')
      .align('center')
      .justify('center')
      .spacing('6')
      .padding('vertical', 'md')
      .border(isActive ? 'primary' : 'transparent', 'thick', 'bottom')
      .onPress(onPress)
      .role('tab')
      .accessibilityState({ selected: isActive })
      .pressFade('75'),
  );

/**
 * Everything the viewer has written but not published, in one sheet.
 *
 * Drafts and scheduled posts are the same shelf from the user's point of view —
 * "things I wrote that aren't out yet" — so they are two TABS rather than two
 * sheets behind two header icons. That is also the shortest fix for how this
 * surface was found missing: people went looking for their scheduled posts in
 * the drafts sheet, which is precisely where the tab now sits.
 *
 * The scheduled query lives here, not in the list, so the tab can show its count
 * (and warm the cache) while the drafts tab is the one on screen.
 *
 * Previewing a scheduled post REPLACES the sheet's body rather than opening a
 * second sheet on top of this one: the preview is a deeper level of the same
 * shelf, and stacking sheets buys nothing but a second dismiss gesture.
 *
 * The drafts tab lists drafts from BOTH places they live — the viewer's account
 * and this device — as one list (`DraftsList`, over `useDraftsList`). An account
 * draft's preview replaces the body like a scheduled post's does, and is looked
 * up by id in the same cached query the list reads, so the two cannot disagree.
 */
const UnpublishedSheet: React.FC<UnpublishedSheetProps> = ({
  onClose,
  onLoadDraft,
  currentDraftId,
}) => {
  const { t } = useTranslation();
  const [switchingDraft, setSwitchingDraft] = useState(false);
  const switchingRef = useRef(false);
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const openDraft = useCallback(
    async (draft: Draft) => {
      if (switchingRef.current) return;
      switchingRef.current = true;
      setSwitchingDraft(true);
      try {
        await onLoadDraft(draft);
      } catch (error) {
        logger.error('Failed to open draft', error);
        if (mountedRef.current)
          toast(
            t('compose.deviceDrafts.loadError', {
              defaultValue: "We couldn't load the drafts saved on this device",
            }),
            { type: 'error' },
          );
      } finally {
        switchingRef.current = false;
        if (mountedRef.current) setSwitchingDraft(false);
      }
    },
    [onLoadDraft, t],
  );
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<UnpublishedTab>('drafts');
  const [previewPostId, setPreviewPostId] = useState<string | null>(null);
  // A draft is LOCAL, so unlike a scheduled post there is no server list to look
  // it back up in — the draft object itself is the only handle there is.
  const [previewDraft, setPreviewDraft] = useState<Draft | null>(null);
  const [previewServerDraftId, setPreviewServerDraftId] = useState<string | null>(null);
  const {
    scheduledPosts,
    isLoading,
    isError,
    refetch,
    cancelScheduledPost,
    publishScheduledPostNow,
    viewerId,
  } = useScheduledPosts();
  const { serverDrafts, publishServerDraft, deleteServerDraft } = useServerDrafts();

  const showDrafts = useCallback(() => setActiveTab('drafts'), []);
  const showScheduled = useCallback(() => setActiveTab('scheduled'), []);

  const openPreview = useCallback((post: HydratedPost) => setPreviewPostId(post.id), []);
  const closePreview = useCallback(() => setPreviewPostId(null), []);
  const openDraftPreview = useCallback((draft: Draft) => setPreviewDraft(draft), []);
  const closeDraftPreview = useCallback(() => setPreviewDraft(null), []);
  const openServerDraftPreview = useCallback(
    (post: HydratedPost) => setPreviewServerDraftId(post.id),
    [],
  );
  const closeServerDraftPreview = useCallback(() => setPreviewServerDraftId(null), []);

  /**
   * Editing reuses the composer's OWN edit route rather than the drafts loader.
   * `onLoadDraft` restores a LOCAL draft — a different shape, with no post id —
   * so saving it would create a second post and leave the scheduled one behind.
   * `/compose?editPostId=` already loads a server post through
   * `GET /posts/:id/edit-source` and saves through `PUT /posts/:id`, which is
   * exactly the update this needs.
   *
   * A server draft takes the same route, for the same reason: it is a server
   * post, so it is edited in place and stays a draft. It is published from here,
   * not from the composer, whose Save on an existing post is an edit.
   */
  const editPost = useCallback(
    (post: HydratedPost) => {
      onClose();
      router.push(`/compose?editPostId=${encodeURIComponent(post.id)}`);
    },
    [onClose, router],
  );

  // Held by ID, not by value: a refetch (or the cancel that drops a row) must be
  // able to take the preview down or refresh it, which a captured object could
  // not do — it would keep rendering a post the server no longer has.
  const previewPost =
    previewPostId === null ? undefined : scheduledPosts.find((post) => post.id === previewPostId);

  // By id, like the scheduled preview, so publishing or deleting it from the row
  // (or a refetch that no longer has it) takes the preview down.
  const previewServerDraft =
    previewServerDraftId === null
      ? undefined
      : serverDrafts.find((post) => post.id === previewServerDraftId);

  if (previewServerDraft) {
    return toElement(
      unpublishedSheet(
        Embed(
          <ServerDraftPreview
            post={previewServerDraft}
            onBack={closeServerDraftPreview}
            onEdit={() => editPost(previewServerDraft)}
            onPublish={publishServerDraft}
            onDelete={deleteServerDraft}
            onDone={closeServerDraftPreview}
          />,
        ),
      ),
    );
  }

  if (previewDraft) {
    return toElement(
      unpublishedSheet(
        Embed(
          <DraftPreview
            draft={previewDraft}
            onBack={closeDraftPreview}
            onEdit={() => {
              closeDraftPreview();
              void openDraft(previewDraft);
            }}
          />,
        ),
      ),
    );
  }

  if (previewPost) {
    return toElement(
      unpublishedSheet(
        Embed(
          <ScheduledPostPreview
            post={previewPost}
            onBack={closePreview}
            onEdit={() => editPost(previewPost)}
            onPublishNow={publishScheduledPostNow}
            onCancel={cancelScheduledPost}
            onCancelled={closePreview}
          />,
        ),
      ),
    );
  }

  return toElement(
    unpublishedSheet(
      Header(t('compose.unpublished', { defaultValue: 'Unpublished' }))
        .safeArea(false)
        .toolbar(
          LButton(Icon(RiCloseLine))
            .shape('circle')
            .style('subtle')
            .tint('neutral')
            .onPress(onClose)
            .label(t('common.close', { defaultValue: 'Close' })),
        )
        .inPage(),
      switchingDraft ? RawText(t('common.saving')).role('alert') : null,
      // The body takes no input and is hidden from assistive technology while a draft opens.
      VStack(
        HStack(
          Embed(
            <TabButton
              label={t('compose.drafts')}
              isActive={activeTab === 'drafts'}
              onPress={showDrafts}
            />,
          ),
          Embed(
            <TabButton
              label={t('compose.scheduled.tab', { defaultValue: 'Scheduled' })}
              count={scheduledPosts.length}
              isActive={activeTab === 'scheduled'}
              onPress={showScheduled}
            />,
          ),
        )
          .border('border', 'thin', 'bottom')
          .role('tablist'),
        Embed(
          activeTab === 'drafts' ? (
            <DraftsList
              onLoadDraft={openDraft}
              onPreviewDraft={openDraftPreview}
              currentDraftId={currentDraftId}
              onPreviewServerDraft={openServerDraftPreview}
              onEditServerDraft={editPost}
            />
          ) : (
            <ScheduledPostsList
              posts={scheduledPosts}
              isLoading={isLoading}
              isError={isError}
              onRetry={refetch}
              onPreview={openPreview}
              onEdit={editPost}
              onCancel={cancelScheduledPost}
              viewerId={viewerId}
            />
          ),
        ),
      )
        .grow()
        .allowsHitTesting(!switchingDraft)
        .accessibilityHidden(switchingDraft),
    ),
  );
};

export default UnpublishedSheet;
