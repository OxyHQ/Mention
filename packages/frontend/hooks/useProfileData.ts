import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useUserByUsername, queryKeys as sdkQueryKeys } from '@oxyhq/services';
import { useAuth } from '@oxyhq/services/ui/client';
import type { AccountKind, User } from '@oxyhq/core';
import { useAppearanceStore, type UserAppearance, type ProfileMedia } from '@/stores/appearanceStore';
import { APP_COLOR_PRESETS, HEX_TO_APP_COLOR } from '@oxyhq/bloom/theme';
import { MEDIA_VARIANT_BANNER } from '@mention/shared-types/post';
import type { Community } from '@/components/Profile/types';
import { displayNameOrHandle } from '@/utils/displayName';
import { getCachedFileDownloadUrlSync, type FileUrlResolver } from '@/utils/imageUrlCache';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

const PROFILE_STALE_TIME = 5 * 60 * 1000; // 5 minutes
const PROFILE_GC_TIME = 30 * 60 * 1000; // 30 minutes

/**
 * React Query key for a federated profile resolved via WebFinger. Mention-owned
 * — the SDK has no by-handle federated-resolve hook, so there is no
 * `queryKeys.users.*` helper for it — but it is rooted at the SDK's
 * `queryKeys.users.details()` so it lives in the users-cache namespace and is
 * cleared alongside the SDK user keys. Viewer-scoped for the same reason as
 * `useUserByUsername`: an authenticated resolve embeds the viewer-relative
 * `relationship` (`followsYou`), so anon vs authed must be distinct entries and
 * a landing session must force a refetch. Defined once here so this Mention-only
 * key has a single source of truth and can never drift from its reader.
 */
export interface ProfileDesign {
  displayName: string;
  bannerUrl?: string;
  avatar?: string;
  /**
   * The compact profile header. DERIVED from the account kind — a channel gets
   * it, everybody else gets the default layout — never chosen.
   *
   * The causality runs THIS way round, and it matters: a channel has no banner,
   * so it gets the layout that has none. Not "minimalist happens to hide the
   * banner, so a channel's is unreachable" — there is nothing to reach.
   * `UpdateAccountInput` has no banner field and `PUT /profile/settings/:userId`
   * accepts only `channel.signPosts`; that is the design, not an omission, and
   * adding either would be building a surface the layout deliberately does not
   * have.
   * There is no stored setting behind this and no picker: the "Profile Style"
   * control and BOTH of its columns (`minimalistMode`, `coverPhotoEnabled`) were
   * removed, so an account that once picked minimalist now renders exactly like
   * any other person's — banner included, which is why `coverPhotoEnabled` had
   * to go with it rather than linger as a suppression nothing could undo.
   */
  minimalistMode: boolean;
  color?: string;
  /** Pinned Syra profile media — a song XOR a podcast — when the user has set one (and the viewer has access). */
  profileMedia?: ProfileMedia;
}

export interface ProfileData {
  id: string;
  username: string;
  /**
   * What KIND of Oxy account this is. `channel` is the one Mention routes
   * differently — a channel's page lives at `/c/<handle>` rather than at
   * `/@<handle>` — so it is named here rather than read off the permissive index
   * signature below, where it would arrive as `unknown` and tempt a cast.
   */
  kind?: AccountKind;
  name: User['name'];
  bio?: string;
  verified?: boolean;
  avatar?: string;
  color?: string;
  createdAt?: string;
  updatedAt?: string;
  postsCount?: number;
  boostsCount?: number;
  repliesCount?: number;
  followsYou?: boolean;
  isFederated?: boolean;
  isAgent?: boolean;
  isAutomated?: boolean;
  isFollowing?: boolean;
  instance?: string;
  actorUri?: string;
  followersCount?: number;
  followingCount?: number;
  primaryLocation?: string;
  verifiedAt?: string;
  usernameChangeCount?: number;
  connectedVia?: string;
  links?: User['links'];
  linksMetadata?: User['linksMetadata'];
  fields?: {
    name?: string;
    value?: string;
    verifiedAt?: string;
  }[];
  communities?: Community[];
  federation?: {
    actorUri?: string;
    domain?: string;
  };
  design: ProfileDesign;
  privacy?: {
    profileVisibility?: 'public' | 'private' | 'followers_only';
  };
  // ProfileData spreads the full Oxy `User` plus arbitrary backend fields that
  // many consumers read positionally (links, joined date, communities, etc.).
  // Keep this permissive to preserve those existing call sites unchanged.
  [key: string]: unknown;
}

/**
 * Computes profile design values from the Oxy profile + backend customization.
 *
 * `bannerUrl` is the one field that needs resolving: `profileHeaderImage` is a
 * media REFERENCE, and both forms occur in the wild — a bare Oxy file id (what
 * the banner picker and the federated-actor mirror write) and an absolute
 * `cloud.oxy.so` URL (what the public design DTO emits, already carrying the
 * banner variant). Renderers must never guess which one they got, so it goes
 * through the canonical resolver here — the same chokepoint Bloom's
 * `ImageResolver` uses — and every consumer receives a real URL. An
 * unresolvable reference yields `undefined` rather than a bare id: consumers
 * render `bannerUrl` straight into an image source and `<meta og:image>`, where
 * a bare id becomes a same-origin request that silently returns the SPA shell.
 *
 * The variant asked for here is {@link MEDIA_VARIANT_BANNER}, the same one the
 * server attaches, so a bare id and a server-resolved URL produce the SAME
 * string — the edit-screen preview and this banner then share one HTTP cache
 * entry instead of fetching two differently-sized copies of the same image.
 */
function computeDesign(
  profile: User,
  appearance: UserAppearance | null | undefined,
  oxyServices: FileUrlResolver,
): ProfileDesign {
  const presetColor =
    typeof profile.color === 'string' && profile.color in APP_COLOR_PRESETS
      ? profile.color
      : undefined;

  const bannerRef = appearance?.profileHeaderImage;
  const bannerUrl = bannerRef
    ? getCachedFileDownloadUrlSync(oxyServices, bannerRef, MEDIA_VARIANT_BANNER)
    : undefined;

  return {
    displayName: displayNameOrHandle(profile.name.displayName, profile.username),
    bannerUrl: bannerUrl?.startsWith('http') ? bannerUrl : undefined,
    avatar: profile.avatar ?? undefined,
    // Read off the ACCOUNT, not off the appearance settings: the layout is a
    // property of what the account is, not a preference it stores.
    minimalistMode: profile.kind === 'channel',
    color:
      presetColor ||
      HEX_TO_APP_COLOR[appearance?.appearance?.primaryColor ?? ''] ||
      'blue',
    // The public design DTO normalizes "no media" to `null`/absent.
    profileMedia: appearance?.profileMedia ?? undefined,
  };
}

/**
 * Unified hook for profile data. Combines:
 * - The Oxy profile (React Query — the single in-memory actor cache).
 * - Appearance/customization settings (HTTP-backed appearance store, works web + native).
 * - Federation data (federated handles resolved server-side via WebFinger).
 *
 * Local handles (`username`) resolve via the SDK's `useUserByUsername`.
 * Federated handles (`user@domain`) resolve via `oxyServices.resolveProfile`,
 * which performs WebFinger discovery and returns `User | null` (never throws).
 */
export function useProfileData(username?: string): {
  data: ProfileData | null;
  loading: boolean;
  error: boolean;
} {
  const { oxyServices, user } = useAuth();
  const viewerId = user?.id ?? '';

  const handle = username ?? '';
  const isFederated = handle.includes('@');

  // Local profiles — SDK hook, shares the singleton React Query cache.
  const localQuery = useUserByUsername(isFederated ? null : handle || null);

  // Federated profiles — server-side WebFinger resolution.
  //
  // `viewerId` is part of the key for the same reason as the local
  // `useUserByUsername` hook: an authenticated profile fetch embeds the
  // viewer-relative `relationship` (`followsYou`), while an anonymous cold-boot
  // fetch omits it. Without the viewer in the key, react-query would freeze the
  // first anonymous copy and never refetch when the session lands ~5-25s later,
  // so the "Follows you" tag would flash then vanish forever. Adding the viewer
  // makes anon vs authed distinct entries AND forces a refetch when the session
  // resolves or the account switches — identical to the local path.
  const federatedQuery = useQuery<User | null>({
    queryKey: viewerQueryKeys.federatedProfile(viewerId, handle),
    queryFn: () => oxyServices.resolveProfile(handle),
    enabled: isFederated && handle.length > 0,
    staleTime: PROFILE_STALE_TIME,
    gcTime: PROFILE_GC_TIME,
  });

  const profile = (isFederated ? federatedQuery.data : localQuery.data) ?? null;
  const isPending = isFederated ? federatedQuery.isPending : localQuery.isPending;
  const isError = isFederated ? federatedQuery.isError : localQuery.isError;

  // Appearance/customization (privacy, cover image, post count, color overrides).
  // Driven by React Query so it dedupes and avoids a manual effect — React Query
  // is the single authority for the foreign-profile design payload (the store's
  // `loadForUser` is now a plain fetcher and holds no per-user cache).
  //
  // `viewerId` is part of the query key because the appearance payload is
  // privacy-gated: a private / followers-only profile returns full design data
  // only to a follower and minimal data otherwise, so the same owner resolves to
  // different payloads per viewer. On cold boot the viewer's session resolves
  // ~5s after mount, so without the viewer in the key the gated data would stay
  // frozen at its anonymous value. The profile/federated queries above stay
  // viewer-independent, so public profile viewing is unaffected.
  const userId = profile?.id ?? '';
  const loadForUser = useAppearanceStore((state) => state.loadForUser);
  const appearanceQuery = useQuery<UserAppearance | null>({
    queryKey: viewerQueryKeys.appearanceForUser(viewerId, userId),
    queryFn: () => loadForUser(userId),
    enabled: userId.length > 0,
    staleTime: PROFILE_STALE_TIME,
    gcTime: PROFILE_GC_TIME,
  });
  const appearance = appearanceQuery.data ?? null;

  const profileData = useMemo<ProfileData | null>(() => {
    if (!profile) return null;

    const design = computeDesign(profile, appearance, oxyServices);
    const federation = profile.federation;
    const followersCount =
      profile._count?.followers ??
      (typeof profile.followersCount === 'number' ? profile.followersCount : 0);
    const followingCount =
      profile._count?.following ??
      (typeof profile.followingCount === 'number' ? profile.followingCount : 0);
    const communities = Array.isArray(profile.communities)
      ? profile.communities.flatMap((entry): Community[] => {
          if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
            const c = entry as { id?: string; name: string; description?: string; icon?: string; memberCount?: number };
            return [{ id: c.id, name: c.name, description: c.description, icon: c.icon, memberCount: c.memberCount }];
          }
          return [];
        })
      : undefined;

    return {
      ...profile,
      id: profile.id || '',
      kind: profile.kind,
      communities,
      username: profile.username || '',
      avatar: profile.avatar ?? undefined,
      color: profile.color ?? undefined,
      postsCount: appearance?.postsCount,
      boostsCount: appearance?.boostsCount,
      repliesCount: appearance?.repliesCount,
      // "Follows you" now rides the Oxy profile fetch: `relationship` is populated
      // on authenticated single-profile fetches (absent for anon/self/bulk), so
      // `undefined` means "unknown", not "does not follow". No extra call and no
      // Mention-side computation — Oxy owns the follow graph.
      followsYou: profile.relationship?.followsYou,
      // Authoritative follow-button seed from the SAME authenticated fetch. The
      // app-root `getViewerGraph` seed is capped at 5000 follows and can lag on
      // cold boot, so a viewer who follows >5000 (or is mid-restore) would flash a
      // wrong "Follow" without this. `undefined` ⇒ unknown; the button then falls
      // back to the follow-store seed.
      isFollowing: profile.relationship?.isFollowing,
      isFederated: profile.isFederated || profile.type === 'federated',
      actorUri:
        (typeof profile.actorUri === 'string' ? profile.actorUri : undefined) ??
        federation?.actorUri,
      instance: profile.instance ?? federation?.domain,
      followersCount,
      followingCount,
      design,
      privacy: appearance?.privacy,
    };
  }, [profile, appearance, oxyServices]);

  // Loading while the query has not yet produced a value. Not-found
  // (resolved with no data) surfaces as an error so the UI can show its
  // empty state instead of an indefinite skeleton.
  const loading = Boolean(handle) && isPending;
  const error = isError || (Boolean(handle) && !isPending && !profile);

  return { data: profileData, loading, error };
}

/**
 * Warms the profile query {@link useProfileData} reads, for a handle the viewer
 * has only pointed at — the hover card's open delay (500ms) is dead time the
 * fetch can run in, so the card mounts with data instead of a spinner.
 *
 * It writes the EXACT keys `useProfileData` reads (the SDK's viewer-scoped
 * by-username entry for local handles, Mention's WebFinger entry for federated
 * ones), so the warmed entry is the one the card renders rather than a second,
 * parallel cache entry. Cheap to over-call: React Query dedupes in flight, and
 * a fresh entry (within {@link PROFILE_STALE_TIME}) is a no-op.
 */
export function usePrefetchProfile(): (username: string) => void {
  const { oxyServices, user } = useAuth();
  const queryClient = useQueryClient();
  const viewerId = user?.id ?? '';

  return useCallback(
    (username: string) => {
      const handle = username.trim();
      if (!handle) return;

      if (handle.includes('@')) {
        queryClient.prefetchQuery({
          queryKey: viewerQueryKeys.federatedProfile(viewerId, handle),
          queryFn: () => oxyServices.resolveProfile(handle),
          staleTime: PROFILE_STALE_TIME,
          gcTime: PROFILE_GC_TIME,
        });
        return;
      }

      queryClient.prefetchQuery({
        // `queryKeys.users.byUsername` lowercases the handle itself, and the SDK
        // hook lowercases it again before fetching — mirror that here so the
        // warmed entry and the hook's own fetch agree by construction.
        queryKey: sdkQueryKeys.users.byUsername(handle, viewerId),
        queryFn: () => oxyServices.getProfileByUsername(handle.toLowerCase()),
        staleTime: PROFILE_STALE_TIME,
        gcTime: PROFILE_GC_TIME,
      });
    },
    [queryClient, oxyServices, viewerId],
  );
}
