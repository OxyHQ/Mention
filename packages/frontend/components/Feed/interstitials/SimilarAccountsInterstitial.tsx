import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { router, type Href } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth, upsertCachedUsers } from '@oxyhq/services';
import { getNormalizedUserHandle, type User } from '@oxyhq/core';
import {
  ProfileCard,
  ProfileCardSkeleton,
  type ProfileCardData,
} from '@/components/ProfileCard';
import { useUserById } from '@/hooks/useCachedUser';
import { queryClient } from '@/lib/queryClient';
import { enrichMissingAvatars } from '@/utils/userEnrichment';
import { DismissButton } from './DismissButton';
import { InterstitialShell, type InterstitialItemContext } from './InterstitialShell';
import {
  INTERSTITIAL_STALE_TIME_MS,
  resolveInterstitialLimits,
  selectInterstitialWindow,
  shouldRenderInterstitial,
} from './interstitialLayout';
import {
  useInterstitialReporter,
  type InterstitialCardProps,
  type ReportInterstitialEvent,
} from './interstitialTelemetry';
import { useIsScreenNotMobile } from '@/hooks/useOptimizedMediaQuery';

/**
 * "Accounts similar to the one whose feed you are reading" — the profile-feed
 * band, and the only one driven by the feed's SUBJECT rather than the viewer's
 * own graph.
 *
 * The subject comes from the slot (`subjectId`), never from the route: the row
 * model this card is spliced into is platform-agnostic and knows nothing about
 * screens. With no subject there is nothing to be similar TO, so the band renders
 * nothing rather than quietly degrading into a second "who to follow" — the
 * server does not plan this kind without a subject (nor on the viewer's own
 * profile), so that path only guards against a malformed slot.
 */
export function SimilarAccountsInterstitial({
  ordinal,
  slotKey,
  feedDescriptor,
  subjectId,
}: SimilarAccountsInterstitialProps) {
  const { t } = useTranslation();
  const isDesktop = useIsScreenNotMobile();
  const { oxyServices, user } = useAuth();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const report = useInterstitialReporter({ feedDescriptor, slotKey, kind: 'similarAccounts' });

  const limits = resolveInterstitialLimits('similarAccounts', isDesktop);

  // The SAME cache entry the profile screen's suggestion strip owns
  // (`components/suggestions/SuggestedUsers.tsx`): same endpoint, same key
  // (subject + viewer), so on a profile feed — where that strip has already
  // fetched — this band costs no extra request, and whichever surface asks first
  // pays for both.
  const query = useQuery<User[]>({
    queryKey: ['similarProfiles', subjectId ?? '', user?.id ?? 'anon'],
    queryFn: async () => {
      if (!subjectId) return [];
      const similar = await oxyServices.getSimilarProfiles(subjectId);
      if (similar.length > 0) {
        upsertCachedUsers(queryClient, similar);
        void enrichMissingAvatars(
          similar.map((profile) => ({ ...profile, avatar: profile.avatar ?? undefined })),
          (ids) => oxyServices.getUsersByIds(ids),
          queryClient,
        );
      }
      // Cached RAW, exactly as the sibling surface caches it — the entry is
      // shared, so what goes in it must not depend on which surface fetched it.
      // Who is fit to SHOW is decided below, on read.
      return similar;
    },
    enabled: Boolean(subjectId),
    staleTime: INTERSTITIAL_STALE_TIME_MS,
  });

  // The subject's own handle, for the way out of the band. Read from the shared
  // actor cache the profile screen already primed, so it is normally a cache hit;
  // until it resolves the band falls back to the app-wide discovery surface rather
  // than render a link to `/@undefined`.
  const subject = useUserById(subjectId);
  const subjectHandle = subject ? (getNormalizedUserHandle(subject) ?? '') : '';
  const seeMoreHref: Href =
    subjectHandle.length > 0 ? `/@${subjectHandle}/who-may-know` : '/explore/who-to-follow';

  // An id-less actor cannot be keyed, followed or opened; and nobody is "similar
  // to" themselves. Applied on READ, not in the fetch, because the cache entry is
  // shared with the profile screen's suggestion strip: the band must be right
  // about its own subject even when that surface filled the entry.
  const pool = useMemo(
    () => (query.data ?? []).filter((account) => account.id !== '' && account.id !== subjectId),
    [query.data, subjectId],
  );

  const accounts = useMemo(
    () => selectInterstitialWindow(pool, ordinal, limits, accountId, dismissed),
    [pool, ordinal, limits, dismissed],
  );

  const handleDismiss = useCallback(
    (id: string, position: number) => {
      report('dismiss', position);
      setDismissed((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
    },
    [report],
  );

  const renderItem = useCallback(
    (account: User, { isCarousel, isLast, position }: InterstitialItemContext) => (
      <SimilarAccountItem
        account={account}
        isCarousel={isCarousel}
        isLast={isLast}
        position={position}
        report={report}
        onDismiss={handleDismiss}
      />
    ),
    [report, handleDismiss],
  );

  const renderSkeleton = useCallback(() => <ProfileCardSkeleton showFollowButton />, []);

  if (!subjectId) return null;

  const isLoading = query.isPending;
  if (!shouldRenderInterstitial(accounts.length, isLoading, limits)) return null;

  return (
    <InterstitialShell
      title={t('feed.interstitial.similarAccounts.title')}
      seeMoreHref={seeMoreHref}
      items={accounts}
      keyExtractor={accountId}
      renderItem={renderItem}
      limits={limits}
      isLoading={isLoading}
      renderSkeleton={renderSkeleton}
      report={report}
    />
  );
}

export interface SimilarAccountsInterstitialProps extends InterstitialCardProps {
  /** The profile the suggestions are ABOUT. Without it the band cannot exist. */
  subjectId?: string;
}

function accountId(account: User): string {
  return account.id;
}

/**
 * Verification is served on the user payload but is not a declared field of the
 * canonical `User` (it arrives through its index signature), so it is read back
 * as the boolean it is rather than asserted to be one.
 */
function isVerified(account: User): boolean | undefined {
  return typeof account.verified === 'boolean' ? account.verified : undefined;
}

interface SimilarAccountItemProps {
  account: User;
  isCarousel: boolean;
  isLast: boolean;
  /** 0-based index within the band — the `position` every item event carries. */
  position: number;
  report: ReportInterstitialEvent;
  onDismiss: (id: string, position: number) => void;
}

/**
 * One similar account — the same {@link ProfileCard} row every other user list in
 * the app renders, so a suggestion here looks and behaves exactly like the same
 * account does in search, followers, or the who-to-follow band.
 */
function SimilarAccountItem({
  account,
  isCarousel,
  isLast,
  position,
  report,
  onDismiss,
}: SimilarAccountItemProps) {
  const { t } = useTranslation();

  const handle = getNormalizedUserHandle(account) ?? '';
  const dismissLabel = t('feed.interstitial.similarAccounts.dismiss', {
    name:
      account.name?.displayName?.trim() ||
      (handle.length > 0 ? `@${handle}` : t('user.unknown')),
  });

  const cardData: ProfileCardData = {
    id: account.id,
    username: account.username,
    name: account.name,
    avatar: account.avatar,
    color: account.color,
    verified: isVerified(account),
    // The carousel card has no room for a bio; the wide desktop row does.
    description: isCarousel ? undefined : account.bio,
    isFederated: account.isFederated,
    instance: account.instance,
    federation: account.federation,
  };

  const row = (
    <ProfileCard
      profile={cardData}
      // Reports the tap, then does exactly what the row does by default. Only
      // wired when there IS somewhere to go: a handle-less (degraded) profile is
      // not pressable, and must not become so just because we want the signal.
      onPress={
        handle.length > 0
          ? () => {
              report('click', position);
              router.push(`/@${handle}`);
            }
          : undefined
      }
      showFollowButton
      onFollowChange={(isFollowing) => {
        // An unfollow is not a follow — the band measures accounts GAINED.
        if (isFollowing) report('follow', position);
      }}
      showDivider={!isCarousel && !isLast}
      accessory={
        <DismissButton
          onPress={() => onDismiss(account.id, position)}
          accessibilityLabel={dismissLabel}
        />
      }
    />
  );

  if (!isCarousel) return row;

  return <View className="bg-card flex-1 justify-center overflow-hidden rounded-xl">{row}</View>;
}
