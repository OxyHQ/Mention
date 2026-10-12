import { useCallback, useMemo, useState } from 'react';
import type { Href } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { cacheActors } from '@/lib/actorCache';
import { useAuth } from '@oxy.so/services/ui/client';
import type { User } from '@oxy.so/core';
import { profileHrefForUser } from '@/components/Profile/profileRoute';
import type { ProfileCardData } from '@/components/ProfileCard';
import { SuggestedProfileCardSkeleton } from '@/components/SuggestedProfileCard';
import { useUserById } from '@/hooks/useCachedUser';
import { enrichMissingAvatars } from '@/utils/userEnrichment';
import { PersonSuggestionItem } from './PersonSuggestionItem';
import { InterstitialShell } from './InterstitialShell';
import {
  INTERSTITIAL_CARD_WIDTH,
  INTERSTITIAL_STALE_TIME_MS,
  resolveInterstitialLimits,
  selectInterstitialWindow,
  shouldRenderInterstitial,
} from './interstitialLayout';
import { useInterstitialReporter, type InterstitialCardProps } from './interstitialTelemetry';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

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
  const { oxyServices, user } = useAuth();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const report = useInterstitialReporter({ feedDescriptor, slotKey, kind: 'similarAccounts' });

  const limits = resolveInterstitialLimits('similarAccounts');

  // The SAME cache entry the profile screen's suggestion strip owns
  // (`components/suggestions/SuggestedUsers.tsx`): same endpoint, same key
  // (subject + viewer), so on a profile feed — where that strip has already
  // fetched — this band costs no extra request, and whichever surface asks first
  // pays for both.
  const query = useQuery<User[]>({
    queryKey: viewerQueryKeys.similarProfiles(user?.id, subjectId),
    queryFn: async () => {
      if (!subjectId) return [];
      const similar = await oxyServices.users.similar(subjectId);
      if (similar.length > 0) {
        cacheActors(similar);
        void enrichMissingAvatars(
          similar.map((profile) => ({ ...profile, avatar: profile.avatar ?? undefined })),
          (ids) => oxyServices.users.getMany(ids),
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
  const seeMoreHref: Href = profileHrefForUser(subject, 'who-may-know') ?? '/explore/who-to-follow';

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
    (account: User, position: number) => (
      <PersonSuggestionItem
        profile={toCardData(account)}
        dismissLabelKey="feed.interstitial.similarAccounts.dismiss"
        position={position}
        report={report}
        onDismiss={handleDismiss}
      />
    ),
    [report, handleDismiss],
  );

  const renderSkeleton = useCallback(() => <SuggestedProfileCardSkeleton />, []);

  if (!subjectId) return null;

  const isLoading = query.isPending;
  if (!shouldRenderInterstitial(accounts.length, isLoading, limits)) return null;

  return (
    <InterstitialShell
      title={t('feed.interstitial.similarAccounts.title')}
      seeMoreHref={seeMoreHref}
      items={accounts}
      keyExtractor={accountId}
      cardWidth={INTERSTITIAL_CARD_WIDTH.profile}
      renderItem={renderItem}
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

/** The tile's view of a similar account. */
function toCardData(account: User): ProfileCardData {
  return {
    id: account.id,
    username: account.username,
    name: account.name,
    avatar: account.avatar,
    color: account.color,
    verified: isVerified(account),
    description: account.bio,
    isFederated: account.isFederated,
    kind: account.kind,
    instance: account.instance,
    federation: account.federation,
  };
}
