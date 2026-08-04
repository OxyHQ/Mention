import React, { memo } from 'react';
import { View, Text } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { SecondaryButton } from '@/components/ui/Button';
import { ProfileCard, ProfileCardSkeletonList } from '@/components/ProfileCard';
import { formatRelativeTimeLocalized } from '@/utils/dateUtils';
import { useChannelWriters } from './hooks/useChannelWriters';

/**
 * A CHANNEL's writers — the people it has already NAMED on its posts.
 *
 * WHAT THIS LIST IS, because the wrong reading of it is the dangerous one: it is
 * who HAS WRITTEN, derived by the server from the channel's public, published
 * posts. Every name here is already on a post any reader can open, so the tab
 * aggregates a disclosure that has happened rather than making a new one. It is
 * NOT the account's member roll, which would name people who have written
 * nothing and consented to nothing. The caption says so on the screen, because a
 * reader looking at a masthead will otherwise assume the other thing.
 *
 * An EMPTY list and NO TAB AT ALL are different facts, and they look different.
 * The strip carries this tab only once the server has confirmed the channel
 * discloses, so arriving here with nothing to show means the channel names its
 * writers and has published nothing signed yet — which is what the empty state
 * says. A channel that does NOT name its writers has no tab to arrive at.
 *
 * Rows are {@link ProfileCard}, the one user row, taking the canonical
 * `PostUser` straight from the DTO with no adapter. That is what gives this list
 * the handle normalization, the avatar resolution (a bare Oxy file id through
 * Bloom's resolver), the live correction of a profile edited in this session,
 * and — the one that matters most here — the ghost-handle rule: a writer Oxy
 * could not resolve arrives with an EMPTY username and renders as "Unknown user"
 * with no `@handle` line and no profile link, never as a raw id.
 *
 * Pagination is a BUTTON rather than an `onEndReached` or a scroll sentinel: a
 * profile tab does not own its scroll (the shell or the feed's list does), so a
 * list here cannot observe the viewport without nesting a second scroller. The
 * page is the server's default of 50 and the set is bounded by how many humans
 * have ever published as this channel, so a second page is rare — and every
 * other non-feed profile tab fetches exactly one page and stops, which this at
 * least improves on.
 */
export const ProfileWriters = memo(function ProfileWriters({
  channelOxyUserId,
}: {
  channelOxyUserId?: string;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const { writers, loading, hasMore, loadingMore, loadMore } = useChannelWriters(channelOxyUserId);

  if (loading) {
    return <ProfileCardSkeletonList count={5} showFollowButton />;
  }

  if (writers.length === 0) {
    return (
      <View className="items-center justify-center p-8 gap-3" style={{ minHeight: 200 }}>
        <Ionicons name="create-outline" size={48} color={theme.colors.textSecondary} />
        <Text className="text-muted-foreground text-base font-medium">
          {t('channels.writers.empty', { defaultValue: 'No writers yet' })}
        </Text>
        <Text className="text-muted-foreground text-sm text-center">
          {t('channels.writers.emptyDetail', {
            defaultValue:
              'This channel names the person who wrote each post. None have been published yet.',
          })}
        </Text>
      </View>
    );
  }

  return (
    <View className="w-full">
      <Text className="text-muted-foreground text-sm px-3 py-3">
        {t('channels.writers.caption', {
          defaultValue: 'The people this channel has named on its posts.',
        })}
      </Text>
      {writers.map((entry, index) => (
        <ProfileCard
          key={entry.writer.id}
          profile={entry.writer}
          showFollowButton
          meta={t('channels.writers.lastWrote', {
            time: formatRelativeTimeLocalized(entry.lastPostAt, t),
            defaultValue: 'Last wrote {{time}}',
          })}
          // The last row's hairline would otherwise sit under nothing — unless
          // the load-more button follows it, which it then separates.
          showDivider={hasMore || index < writers.length - 1}
        />
      ))}
      {hasMore ? (
        <View className="p-4">
          {/* The label does not change while the page is in flight: `Button` has
              no loading state, and a second string here would be a new catalog
              entry for a moment nobody reads. `disabled` is what says it. */}
          <SecondaryButton onPress={loadMore} disabled={loadingMore}>
            {t('common.loadMore')}
          </SecondaryButton>
        </View>
      ) : null}
    </View>
  );
});
