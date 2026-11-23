import { memo, useCallback } from 'react';
import { StyleSheet } from 'react-native';
import { useRouter } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import { formatCompactNumber } from '@/utils/formatNumber';
import type { ProfileStatsProps } from './types';

import { Embed, HStack, RawText, toElement } from '@oxy.so/bloom-language';

import {
  Embed as LEmbed,
  HStack as LHStack,
  toElement as LtoElement,
} from '@oxy.so/bloom-language';

/** A stat's count and its label, at 15pt: the count bold in the foreground, the label muted. */
const statNumber = (value: string) =>
  RawText(value).font('md').weight('bold').foreground('foreground');
const statLabel = (label: string) => RawText(label).font('md').foreground('muted');

/**
 * Profile statistics component
 * Displays following, followers, posts, boosts, and replies counts with navigation.
 * A follow-graph count that is `undefined` is unknown and its stat is omitted.
 */
export const ProfileStats = memo(function ProfileStats({
  followingCount,
  followerCount,
  accountKind,
  postsCount,
  boostsCount,
  repliesCount,
  reputationTotal,
  showReplies = true,
  followingHref,
  followersHref,
  onPostsPress,
  onBoostsPress,
  onRepliesPress,
}: ProfileStatsProps) {
  const router = useRouter();
  const { t } = useTranslation();

  const handleFollowingPress = useCallback(() => {
    if (followingHref) router.push(followingHref);
  }, [followingHref, router]);

  const handleFollowersPress = useCallback(() => {
    if (followersHref) router.push(followersHref);
  }, [followersHref, router]);

  return toElement(
    HStack(
      Embed(
        (render) =>
          followingCount !== undefined &&
          LtoElement(
            LHStack(
              LEmbed(render(statNumber(formatCompactNumber(followingCount)))),
              LEmbed(render(statLabel(t('profile.following')))),
            )
              .align('center')
              .spacing('xs')
              .onPress(handleFollowingPress)
              .disabled(!followingHref)
              .pressFade(),
          ),
      ),
      Embed(
        (render) =>
          followerCount !== undefined &&
          LtoElement(
            LHStack(
              LEmbed(render(statNumber(formatCompactNumber(followerCount)))),
              LEmbed(
                render(
                  statLabel(
                    t(accountKind === 'community' ? 'profile.members' : 'profile.followers'),
                  ),
                ),
              ),
            )
              .align('center')
              .spacing('xs')
              .onPress(handleFollowersPress)
              .disabled(!followersHref)
              .pressFade(),
          ),
      ),
      Embed((render) =>
        LtoElement(
          LHStack(
            LEmbed(render(statNumber(formatCompactNumber(postsCount ?? 0)))),
            LEmbed(render(statLabel(t('profile.stats.posts', { count: postsCount ?? 0 })))),
          )
            .align('center')
            .spacing('xs')
            .onPress(onPostsPress)
            .pressFade(),
        ),
      ),
      Embed((render) =>
        LtoElement(
          LHStack(
            LEmbed(render(statNumber(formatCompactNumber(boostsCount ?? 0)))),
            LEmbed(render(statLabel(t('profile.stats.boosts', { count: boostsCount ?? 0 })))),
          )
            .align('center')
            .spacing('xs')
            .onPress(onBoostsPress)
            .pressFade(),
        ),
      ),
      Embed(
        (render) =>
          showReplies &&
          LtoElement(
            LHStack(
              LEmbed(render(statNumber(formatCompactNumber(repliesCount ?? 0)))),
              LEmbed(render(statLabel(t('profile.stats.replies', { count: repliesCount ?? 0 })))),
            )
              .align('center')
              .spacing('xs')
              .onPress(onRepliesPress)
              .pressFade(),
          ),
      ),
      reputationTotal !== undefined
        ? HStack(
            statNumber(reputationTotal === null ? '--' : formatCompactNumber(reputationTotal)),
            statLabel(t('profile.stats.reputation')),
          )
            .spacing('xs')
            .align('center')
        : null,
    )
      .spacing('10')
      .wrap()
      .margin('bottom', 'md'),
  );
});

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 12,
  },
  statItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
});
