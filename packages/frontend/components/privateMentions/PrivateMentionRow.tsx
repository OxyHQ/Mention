import { memo } from 'react';
import { skipToken, useQueries } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChatListItem } from '@oxy.so/bloom/chat-list';
import type { ChatFace, ChatPreview } from '@oxy.so/bloom/chat-list';
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { queryKeys } from '@oxy.so/services/ui/client';
import type { User } from '@oxy.so/core';
import type { PrivateMentionConversation } from '@mention/shared-types';
import { useRouter } from '@/lib/navigation/router';
import { displayNameOrHandle } from '@/utils/displayName';
import { formatRelativeTime, useBloomLocale } from '@oxy.so/bloom/locale';

/** A conversation row draws at most this many faces (Bloom's group avatar cap). */
const MAX_FACES = 4;

/** The fields a row draws, common to a cached Oxy `User` and a hydrated `PostUser`. */
interface Participant {
  id: string;
  username?: string;
  avatar?: string | null;
  name?: { displayName?: string | null } | null;
}

function participantName(participant: Participant | undefined): string {
  if (!participant) return '';
  return displayNameOrHandle(
    participant.name?.displayName,
    participant.username ? `@${participant.username}` : '',
  );
}

/**
 * One private-mention conversation, drawn by Bloom's `ChatListItem`: who it is
 * with, the newest post's text, when it last moved, and a lock that says only
 * those people can read it. Participants come from the shared Oxy user cache,
 * which `usePrivateMentionConversations` warms in one batch — this row reads it
 * without fetching (and falls back to the latest post's author, which arrives
 * hydrated).
 */
export const PrivateMentionRow = memo(function PrivateMentionRow({
  conversation,
  viewerId,
}: {
  conversation: PrivateMentionConversation;
  viewerId: string | undefined;
}) {
  const { t } = useTranslation();
  const locale = useBloomLocale();
  const theme = useTheme();
  const router = useRouter();
  const { latestPost, participantIds, rootId, lastActivityAt } = conversation;

  const cached = useQueries({
    queries: participantIds.slice(0, MAX_FACES).map((id) => ({
      queryKey: queryKeys.users.detail(id),
      queryFn: skipToken,
    })),
  });

  const participants: Participant[] = participantIds.slice(0, MAX_FACES).map((id, index) => {
    const user = cached[index]?.data as User | undefined;
    if (user) return user;
    if (latestPost.user?.id === id) return latestPost.user;
    return { id };
  });

  // Up to two names, then "and N more" for everyone not named (including any
  // participant whose profile has not resolved yet).
  const [first, second] = participants.map(participantName).filter(Boolean);
  const named = second ? 2 : first ? 1 : 0;
  const others = participantIds.length - named;
  const name = !first
    ? t('privateMentions.title', { defaultValue: 'Private mentions' })
    : !second
      ? others > 0
        ? t('privateMentions.oneAndMore', {
            defaultValue: '{{first}} and {{others}} more',
            first,
            others,
          })
        : first
      : others > 0
        ? t('privateMentions.manyNames', {
            defaultValue: '{{first}}, {{second}} and {{others}} more',
            first,
            second,
            others,
          })
        : t('privateMentions.twoNames', {
            defaultValue: '{{first}} and {{second}}',
            first,
            second,
          });

  const faces: ChatFace[] | undefined =
    participants.length > 1
      ? participants.map((participant) => ({
          source: participant.avatar ?? undefined,
          name: participantName(participant) || undefined,
        }))
      : undefined;

  const text = latestPost.content?.text?.trim();
  const hasMedia = (latestPost.content?.media?.length ?? 0) > 0;
  const fromViewer = Boolean(viewerId) && latestPost.user?.id === viewerId;
  const sender = fromViewer
    ? t('privateMentions.you', { defaultValue: 'You' })
    : participantIds.length > 1
      ? participantName(latestPost.user) || undefined
      : undefined;
  const preview: ChatPreview = text
    ? { text, sender }
    : hasMedia
      ? {
          sender,
          attachment: {
            kind: 'photo',
            label: t('privateMentions.media', { defaultValue: 'Media' }),
          },
        }
      : { text: '', sender };

  const time = formatRelativeTime(new Date(lastActivityAt), locale, { style: 'short' });
  const badge = t('privateMentions.badge', { defaultValue: 'Private mention' });

  return (
    <ChatListItem
      name={name}
      avatar={faces ? undefined : (participants[0]?.avatar ?? undefined)}
      faces={faces}
      kind={faces ? 'group' : 'direct'}
      marker={<RiLockLine width={14} height={14} fill={theme.colors.textSecondary} />}
      preview={preview}
      time={time}
      onPress={() => router.push(`/p/${rootId}`)}
      accessibilityLabel={[name, badge, sender ? `${sender}: ${text ?? ''}` : text, time]
        .filter(Boolean)
        .join(', ')}
      swipeEnabled={false}
      testID={`private-mention-${rootId}`}
    />
  );
});
