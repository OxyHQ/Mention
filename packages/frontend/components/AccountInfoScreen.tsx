import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { ThemedText } from '@/components/ThemedText';
import { ThemedView } from '@/components/ThemedView';
import { Avatar } from '@oxyhq/bloom/avatar';
import { MEDIA_VARIANT_AVATAR_LG } from '@mention/shared-types/post';
import { Redirect } from 'expo-router';
import { useSafeBack } from '@/hooks/useSafeBack';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { View, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import UserName from '@/components/UserName';
import { RowIcon } from '@/components/settings/RowIcon';
import { VerifiedIcon } from '@/assets/icons/verified-icon';
import { CalendarMonthIcon } from '@/assets/icons/calendar-month-icon';
import { FediverseIcon } from '@/assets/icons/fediverse-icon';
import { ExternalLinkIcon } from '@/assets/icons/external-link-icon';
import { showFediverseInfo } from '@/components/Fediverse/FediverseInfoDialog';
import { openExternalLink } from '@/utils/openExternalLink';
import { getNormalizedUserHandle } from '@oxyhq/core';
import type { ExternalNetwork } from '@/services/feedService';
import type { ProfileData } from '@/hooks/useProfileData';
import { useAccountCategoryLabel } from '@/hooks/useAccountCategoryLabel';
import { nameableAccountCategoryIds } from '@/utils/accountCategories';
import { useProfileAccount } from '@/components/Profile/hooks/useProfileAccount';
import type { ProfileRouteFamily } from '@/components/Profile/profileRoute';
import { BloomColorScope } from '@oxyhq/bloom/theme';
import { Loading } from '@oxyhq/bloom/loading';

/**
 * Bluesky's canonical network domain — an atproto account's `instance` is ALWAYS
 * this (a Bluesky handle is a whole DNS name, not a `local@host` address), so it
 * is the reliable discriminator between an ActivityPub (Mastodon, …) actor and a
 * Bluesky (atproto) one. Mirrors the backend `BSKY_NETWORK_DOMAIN` constant.
 */
const BLUESKY_NETWORK_DOMAIN = 'bsky.social';

/**
 * An account's "about" surface — joined date, location, website, verification,
 * and where else on the network it can be reached.
 *
 * ONE component, composed by BOTH route families: `/@<handle>/about` for a
 * person and `/c/<handle>/about` for a channel. The page itself is the same
 * question either way ("what is this account"), and every field on it exists on
 * a channel account too, so a second implementation would be a second place for
 * the identity rules to drift — the same reason the two profile screens share
 * their primitives rather than their code being copied.
 *
 * What the family DOES decide is the URL, which is why it arrives as a prop
 * rather than being sniffed from the pathname: the reader must end up on the
 * route their account owns, and `useProfileAccount` canonicalizes them there —
 * carrying the `about` segment across, so a wrong-family link lands on the
 * about page rather than at the top of the profile.
 */
export function AccountInfoScreen({ routedFamily }: { routedFamily: ProfileRouteFamily }) {
  const { profileData, loading: profileLoading, colorName, canonicalHref } = useProfileAccount(
    routedFamily,
    'about',
  );

  if (canonicalHref) {
    return <Redirect href={canonicalHref} />;
  }

  return (
    <BloomColorScope colorPreset={colorName} asChild>
      <AccountInfoContent profileData={profileData} profileLoading={profileLoading} />
    </BloomColorScope>
  );
}

interface AccountInfoContentProps {
  profileData: ProfileData | null;
  profileLoading: boolean;
}

function AccountInfoContent({ profileData, profileLoading }: AccountInfoContentProps) {
  const insets = useSafeAreaInsets();
  const safeBack = useSafeBack();
  const { t } = useTranslation();
  const categoryLabel = useAccountCategoryLabel();

  // Format join date
  const joinDate = useMemo(() => {
    if (!profileData?.createdAt) return null;
    return new Date(profileData.createdAt).toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric'
    });
  }, [profileData?.createdAt]);

  // Format verified date if available (using createdAt as fallback)
  const verifiedDate = useMemo(() => {
    if (!profileData?.verified) return null;
    // If we have a verifiedAt date, use it, otherwise use createdAt
    const dateToUse = profileData.verifiedAt || profileData.createdAt;
    if (!dateToUse) return null;
    return new Date(dateToUse).toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric'
    });
  }, [profileData?.verified, profileData?.verifiedAt, profileData?.createdAt]);

  // Every category the account carries that this build can name, in the
  // account's OWN order — the first is its primary. Filtered, never sorted:
  // sorting would destroy the one thing the order encodes, and an id from a
  // newer vocabulary is dropped rather than shown as its raw slug (this screen
  // is for readers, so a row saying "unavailable" would be noise; the picker,
  // whose reader OWNS the account, keeps it instead).
  const categories = useMemo(
    () =>
      nameableAccountCategoryIds(profileData?.accountCategories).map((id) => ({
        id,
        label: categoryLabel(id),
      })),
    [profileData?.accountCategories, categoryLabel],
  );

  // Federation identity for the Fediverse / Bluesky section (federated profiles
  // only): the network, the canonical `@user@domain` handle, and a web-openable
  // URL to the account's ORIGINAL profile page. A Mastodon actor URL redirects a
  // browser GET to the human-readable profile; an atproto DID / handle resolves
  // on bsky.app's `/profile/<id>` route.
  const federationInfo = useMemo(() => {
    if (!profileData?.isFederated) return null;
    const actorUri = profileData.actorUri;
    const instance = profileData.instance;
    const isBluesky =
      instance === BLUESKY_NETWORK_DOMAIN ||
      (actorUri?.startsWith('did:') ?? false) ||
      (actorUri?.startsWith('at://') ?? false);
    const network: ExternalNetwork = isBluesky ? 'atproto' : 'activitypub';
    const handle = getNormalizedUserHandle({
      username: profileData.username,
      instance,
      isFederated: true,
    });

    let originalProfileUrl: string | null = null;
    if (actorUri?.startsWith('https://') || actorUri?.startsWith('http://')) {
      originalProfileUrl = actorUri;
    } else if (isBluesky && actorUri) {
      // bsky.app resolves both DIDs and handles at `/profile/<id>`.
      const id = actorUri.startsWith('at://') ? actorUri.slice('at://'.length).split('/')[0] : actorUri;
      originalProfileUrl = id ? `https://bsky.app/profile/${id}` : null;
    }

    return { network, instance, handle, originalProfileUrl };
  }, [profileData?.isFederated, profileData?.actorUri, profileData?.instance, profileData?.username]);

  // Same back-nav header the sibling profile sub-screens (followers / following /
  // connections) render: shared <Header>, non-sticky, no bottom border. Rendered
  // once and reused across the loading / not-found / loaded states so all three
  // share identical chrome.
  const header = (
    <Header
      options={{
        title: t('About', { defaultValue: 'About' }),
        leftComponents: [
          <IconButton key="back" variant="icon" onPress={() => safeBack()}>
            <BackArrowIcon size={20} className="text-foreground" />
          </IconButton>,
        ],
      }}
      hideBottomBorder
      disableSticky
    />
  );

  if (profileLoading) {
    return (
      <ThemedView className="flex-1" style={{ paddingTop: insets.top }}>
        {header}
        <View className="flex-1 items-center justify-center">
          <Loading className="text-primary" size="large" />
        </View>
      </ThemedView>
    );
  }

  if (!profileData) {
    return (
      <ThemedView className="flex-1" style={{ paddingTop: insets.top }}>
        {header}
        <View className="flex-1 items-center justify-center px-6">
          <ThemedText className="text-base text-muted-foreground text-center">
            {t('profile.notFound.title', { defaultValue: 'Profile not found' })}
          </ThemedText>
        </View>
      </ThemedView>
    );
  }

  const avatarUri = profileData.design.avatar ?? profileData.avatar;
  const hasUsernameChanges = (profileData.usernameChangeCount ?? 0) > 0;
  // Canonical single website for the account (a real Oxy `User` field, distinct
  // from the multi-link list surfaced on the main profile). Shown as a tappable
  // row; a bare host (no scheme) is normalized to https so the opener accepts it.
  const website =
    typeof profileData.website === 'string' && profileData.website.trim().length > 0
      ? profileData.website.trim()
      : null;
  const websiteUrl = website ? (/^https?:\/\//i.test(website) ? website : `https://${website}`) : null;
  const hasAccountDetails =
    Boolean(joinDate) ||
    Boolean(profileData.primaryLocation) ||
    Boolean(websiteUrl) ||
    hasUsernameChanges ||
    Boolean(profileData.connectedVia);

  return (
    <ThemedView className="flex-1" style={{ paddingTop: insets.top }}>
      {header}

      {/* Horizontal padding lives on the identity block and the Bloom settings
          groups (which carry their own 16px card margin), NOT on the scroller —
          so both align to the same 16px gutter as the profile header, and the
          settings cards are never double-inset. Vertical rhythm mirrors the
          settings screens (the app's other SettingsListGroup surface). */}
      <ScrollView className="flex-1" contentContainerClassName="pb-6">
        {/* Identity header — a classic CENTERED profile header: the avatar
            centered on top, then the display name, then the muted @handle, all
            horizontally centered (via `items-center` + UserName's `align="center"`).
            Keeps the profile's typographic scale (24px display name, 15px muted
            @handle) and inline verified / federated / agent badges via the shared
            UserName, so it reads as the same identity surface as the profile. */}
        <View className="px-4 pt-4 pb-5 items-center">
          <Avatar source={avatarUri} size={80} variant={MEDIA_VARIANT_AVATAR_LG} />
          <UserName
            name={profileData.design.displayName ?? profileData.name?.displayName}
            handle={profileData.username}
            verified={profileData.verified}
            isFederated={profileData.isFederated}
            kind={profileData.kind}
            // Deliberately NOT opted in: this screen already carries an explicit
            // "Learn more about the fediverse" row below, which is a better
            // affordance than a 15px glyph. Two doors to one dialog on one
            // screen is one more than the screen needs.
            isAgent={profileData.isAgent}
            isAutomated={profileData.isAutomated}
            copyableHandle
            align="center"
            variant="default"
            // UserName exposes name/handle sizing only through this typed style
            // object (no 24px `variant`), so the profile header itself sets the
            // display-name scale the same way — matched here for parity.
            style={{
              name: { fontSize: 24, fontWeight: 'bold', marginTop: 12, marginBottom: 4 },
              handle: { fontSize: 15 },
            }}
          />
        </View>

        {/* Categories — the WHOLE ordered list, which is what makes this the
            counterpart to the profile: the header names only the primary, so
            without this surface the other three would be unreadable anywhere.
            The order is the account's own and is never sorted here; the first
            row is marked as the primary, which is the only thing that explains
            why that one and not another appears under the name. */}
        {categories.length > 0 && (
          <SettingsListGroup title={t('accountCategories.title', { defaultValue: 'Categories' })}>
            {categories.map((category, index) => (
              <SettingsListItem
                key={category.id}
                icon={<RowIcon name="pricetags" />}
                title={category.label}
                value={
                  index === 0
                    ? t('accountCategories.primary', { defaultValue: 'Primary' })
                    : undefined
                }
              />
            ))}
          </SettingsListGroup>
        )}

        {/* Account details — dates, location, activity */}
        {hasAccountDetails && (
          <SettingsListGroup title={t('Account details', { defaultValue: 'Account details' })}>
            {joinDate && (
              <SettingsListItem
                icon={<CalendarMonthIcon size={20} className="text-muted-foreground" />}
                title={t('Date joined', { defaultValue: 'Date joined' })}
                value={joinDate}
              />
            )}

            {profileData.primaryLocation && (
              <SettingsListItem
                icon={<RowIcon name="location" />}
                title={t('Account based in', { defaultValue: 'Account based in' })}
                value={profileData.primaryLocation}
              />
            )}

            {websiteUrl && (
              <SettingsListItem
                icon={<RowIcon name="link" />}
                title={t('Website', { defaultValue: 'Website' })}
                value={website?.replace(/^https?:\/\//i, '')}
                onPress={() => openExternalLink(websiteUrl)}
              />
            )}

            {hasUsernameChanges && (
              <SettingsListItem
                icon={<RowIcon name="at" />}
                title={t('Username changes', { defaultValue: 'Username changes' })}
                value={String(profileData.usernameChangeCount)}
              />
            )}

            {profileData.connectedVia && (
              <SettingsListItem
                icon={<RowIcon name="globe" />}
                title={t('Connected via', { defaultValue: 'Connected via' })}
                value={profileData.connectedVia}
              />
            )}
          </SettingsListGroup>
        )}

        {/* Verification — its own section, matching the profile's emphasis on the
            verified badge */}
        {profileData.verified && (
          <SettingsListGroup title={t('Verification', { defaultValue: 'Verification' })}>
            <SettingsListItem
              icon={<VerifiedIcon size={20} className="text-primary" />}
              title={t('Verified', { defaultValue: 'Verified' })}
              value={verifiedDate
                ? t('Since {date}', { date: verifiedDate, defaultValue: `Since ${verifiedDate}` })
                : t('Verified account', { defaultValue: 'Verified account' })}
            />
          </SettingsListGroup>
        )}

        {/* Fediverse / Bluesky — federated accounts only. Explains where the
            account actually lives (its network + home server), surfaces the full
            cross-network handle, and links out to the original profile. The footer
            blurb reuses the fediverse copy tone; a "Learn more" row opens the
            existing educational FediverseInfoSheet (fediverse networks only —
            Bluesky is a separate network, not the fediverse). */}
        {federationInfo && (
          <SettingsListGroup
            title={federationInfo.network === 'atproto'
              ? t('fediverse.about.titleBluesky', { defaultValue: 'Bluesky' })
              : t('fediverse.about.title', { defaultValue: 'Fediverse' })}
            footer={federationInfo.network === 'atproto'
              ? t('fediverse.about.descriptionBluesky', {
                  instance: federationInfo.instance ?? BLUESKY_NETWORK_DOMAIN,
                  defaultValue: 'This account lives on Bluesky ({{instance}}). You can follow it and reply from Mention just like a native account.',
                })
              : t('fediverse.about.descriptionActivityPub', {
                  instance: federationInfo.instance ?? '',
                  defaultValue: 'This account lives on another server in the fediverse ({{instance}}). You can follow it and reply from Mention just like a native account.',
                })}
          >
            <SettingsListItem
              icon={federationInfo.network === 'atproto'
                ? <RowIcon name="planet" />
                : <FediverseIcon size={20} className="text-muted-foreground" />}
              title={t('fediverse.about.network', { defaultValue: 'Network' })}
              value={federationInfo.network === 'atproto'
                ? t('fediverse.about.networkBluesky', { defaultValue: 'Bluesky' })
                : t('fediverse.about.networkActivityPub', { defaultValue: 'ActivityPub' })}
            />

            {federationInfo.instance && (
              <SettingsListItem
                icon={<RowIcon name="server" />}
                title={t('fediverse.about.homeServer', { defaultValue: 'Home server' })}
                value={federationInfo.instance}
              />
            )}

            {federationInfo.handle && (
              <SettingsListItem
                icon={<RowIcon name="at" />}
                title={t('fediverse.about.handle', { defaultValue: 'Handle' })}
                value={`@${federationInfo.handle}`}
              />
            )}

            {federationInfo.originalProfileUrl && (
              <SettingsListItem
                icon={<ExternalLinkIcon size={20} className="text-muted-foreground" />}
                title={t('fediverse.about.viewOriginal', { defaultValue: 'View original profile' })}
                onPress={() => {
                  if (federationInfo.originalProfileUrl) openExternalLink(federationInfo.originalProfileUrl);
                }}
              />
            )}

            {federationInfo.network === 'activitypub' && (
              <SettingsListItem
                icon={<FediverseIcon size={20} className="text-muted-foreground" />}
                title={t('fediverse.about.learnMore', { defaultValue: 'Learn more about the fediverse' })}
                onPress={() => showFediverseInfo()}
              />
            )}
          </SettingsListGroup>
        )}
      </ScrollView>
    </ThemedView>
  );
}
