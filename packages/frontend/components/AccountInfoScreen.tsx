import { DetailSkeleton } from '@/components/loading/ContentSkeleton';
import { SupervisedFeatureGate } from '@/components/SupervisedFeatureGate';
import { ZoomableAvatar } from '@/components/ZoomableAvatar';
import { Redirect } from '@/lib/navigation/router';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';

import UserName from '@/components/UserName';
import { RowIcon } from '@/components/settings/RowIcon';
import { RiAtLine } from '@oxy.so/bloom/icons/RiAtLine';
import { RiDatabase2Line } from '@oxy.so/bloom/icons/RiDatabase2Line';
import { RiEarthLine } from '@oxy.so/bloom/icons/RiEarthLine';
import { RiHashtag } from '@oxy.so/bloom/icons/RiHashtag';
import { RiLinkM } from '@oxy.so/bloom/icons/RiLinkM';
import { RiMapPinLine } from '@oxy.so/bloom/icons/RiMapPinLine';
import { RiCalendar2Line } from '@oxy.so/bloom/icons/RiCalendar2Line';
import { RiExternalLinkLine } from '@oxy.so/bloom/icons/RiExternalLinkLine';
import { RiFediverseLine } from '@oxy.so/bloom/icons/RiFediverseLine';
import { RiVerifiedBadgeFill } from '@oxy.so/bloom/icons/RiVerifiedBadgeFill';
import { VERIFIED_BADGE_COLOR } from '@/styles/colors';
import { showFediverseInfo } from '@/components/Fediverse/FediverseInfoDialog';
import { openExternalLink } from '@/utils/openExternalLink';
import { BLUESKY_NETWORK_DOMAIN, federationInfoOf } from '@/utils/federationInfo';
import type { ProfileData } from '@/hooks/useProfileData';
import { useAccountCategoryLabel } from '@/hooks/useAccountCategoryLabel';
import { nameableAccountCategoryIds } from '@/utils/accountCategories';
import {
  useProfileAccount,
  useProfileCanonicalHref,
} from '@/components/Profile/hooks/useProfileAccount';
import { useRoutedProfileUsername } from '@/components/Profile/hooks/useRoutedProfileUsername';
import { profileRouteFamily, type ProfileRouteFamily } from '@/components/Profile/profileRoute';
import { galleryProfilePermalink } from '@/utils/gallerySharePermalink';
import { ProfileUnavailable } from '@/components/Profile/ProfileUnavailable';
import { resolveProfileColor } from '@oxy.so/bloom/color-presets';
import { Screen } from '@oxy.so/bloom/screen';
import { useTheme } from '@oxy.so/bloom/theme';

import {
  Embed,
  GroupedSection as LGroupedSection,
  GroupedSectionItem as LGroupedSectionItem,
  Header,
  Icon,
  ScrollView,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

const ABOUT_AVATAR_SIZE = 80;

/** The pronoun pairs a person account can name, as they read on the About page. */
const PRONOUN_LABELS: Record<string, string> = {
  he_him: 'He/him',
  she_her: 'She/her',
  they_them: 'They/them',
  he_they: 'He/they',
  she_they: 'She/they',
  it_its: 'It/its',
};

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
  return (
    <SupervisedFeatureGate>
      <AccountInfoScreenContent routedFamily={routedFamily} />
    </SupervisedFeatureGate>
  );
}

function AccountInfoScreenContent({ routedFamily }: { routedFamily: ProfileRouteFamily }) {
  const account = useProfileAccount(useRoutedProfileUsername());
  const { profileData, loading: profileLoading, notFound, refresh } = account;
  const canonicalHref = useProfileCanonicalHref({ routedFamily, account, subpath: 'about' });
  const { t } = useTranslation();

  if (canonicalHref) {
    return <Redirect href={canonicalHref} />;
  }

  const color = resolveProfileColor(profileData?.design.color);

  // As in ProfileShell: the profile's colour (preset or seed) is the Screen's
  // claim, which themes the whole shell on a split layout.
  //
  // Same back-nav header the sibling profile sub-screens (followers / following /
  // connections) render, shared by the loading / not-found / loaded states.
  const content = toElement(
    ScrollView(
      Embed(
        <AccountInfoContent
          profileData={profileData}
          profileLoading={profileLoading}
          notFound={notFound}
          onRetry={refresh}
        />,
      ),
    ),
  );
  if (Platform.OS === 'web' && routedFamily === 'person') return content;
  return (
    <Screen
      scroll={Platform.OS === 'web' ? 'auto' : 'content'}
      colorPreset={color?.colorPreset}
      seed={color?.seed}
      header={toElement(
        Header(t('profile.about.title', { defaultValue: 'About' }))
          .backLabel(t('common.back', { defaultValue: 'Back' }))
          .inPage(),
      )}
    >
      {content}
    </Screen>
  );
}

interface AccountInfoContentProps {
  profileData: ProfileData | null;
  profileLoading: boolean;
  notFound: boolean;
  onRetry: () => Promise<void>;
}

function AccountInfoContent({
  profileData,
  profileLoading,
  notFound,
  onRetry,
}: AccountInfoContentProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const categoryLabel = useAccountCategoryLabel();

  // Format join date
  const joinDate = useMemo(() => {
    if (!profileData?.createdAt) return null;
    return new Date(profileData.createdAt).toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric',
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
      year: 'numeric',
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

  // Federation identity for the Fediverse section (federated profiles
  // only): the network, the canonical `@user@domain` handle, and a web-openable
  // URL to the account's ORIGINAL profile page. A Mastodon actor URL redirects a
  // browser GET to the human-readable profile; an atproto DID / handle resolves
  // on bsky.app's `/profile/<id>` route.
  const federationInfo = useMemo(() => federationInfoOf(profileData), [profileData]);

  if (profileLoading) {
    return <DetailSkeleton />;
  }

  if (!profileData) {
    return <ProfileUnavailable notFound={notFound} onRetry={onRetry} />;
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
  const websiteUrl = website
    ? /^https?:\/\//i.test(website)
      ? website
      : `https://${website}`
    : null;
  // The account's structured pronouns; `unspecified` (or none) shows no row.
  const pronouns = profileData.pronouns ? PRONOUN_LABELS[profileData.pronouns] : undefined;
  const hasAccountDetails =
    Boolean(joinDate) ||
    Boolean(profileData.primaryLocation) ||
    Boolean(websiteUrl) ||
    hasUsernameChanges ||
    Boolean(profileData.connectedVia);

  // Horizontal padding lives on the identity block and the Bloom settings
  // groups (which carry their own 16px card margin), NOT on the scroller — so
  // both align to the same 16px gutter as the profile header, and the settings
  // cards are never double-inset. Vertical rhythm mirrors the settings screens
  // (the app's other SettingsListGroup surface).
  return toElement(
    VStack(
      /* Identity header — a classic CENTERED profile header: the avatar
              centered on top, then the display name, then the muted @handle, all
              horizontally centered (via `items-center` + UserName's `align="center"`).
              Keeps the profile's typographic scale (24px display name, 15px muted
              @handle) and inline verified / federated / agent badges via the shared
              UserName, so it reads as the same identity surface as the profile. */ VStack(
        Embed(
          <ZoomableAvatar
            shareUrl={
              galleryProfilePermalink(profileData.username, profileRouteFamily(profileData)) ?? null
            }
            account={profileData}
            source={avatarUri}
            size={ABOUT_AVATAR_SIZE}
            className="bg-muted"
            style={{
              width: ABOUT_AVATAR_SIZE,
              height: ABOUT_AVATAR_SIZE,
              borderRadius: ABOUT_AVATAR_SIZE / 2,
            }}
          />,
        ),
        Embed(
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
          />,
        ),
      )
        .padding('horizontal', 'lg')
        .padding('top', 'lg')
        .padding('bottom', 'xl')
        .align('center'),
      /* Categories — the WHOLE ordered list, which is what makes this the
              counterpart to the profile: the header names only the primary, so
              without this surface the other three would be unreadable anywhere.
              The order is the account's own and is never sorted here; the first
              row is marked as the primary, which is the only thing that explains
              why that one and not another appears under the name. */ categories.length > 0
        ? LGroupedSection(
            Embed(
              categories.map((category, index) =>
                toElement(
                  LGroupedSectionItem(category.label)
                    .leadingView(Embed(<RowIcon icon={RiHashtag} />))
                    .value(
                      index === 0
                        ? t('accountCategories.primary', { defaultValue: 'Primary' })
                        : undefined,
                    ),
                  category.id,
                ),
              ),
            ),
          ).title(t('accountCategories.title', { defaultValue: 'Categories' }))
        : null,
      /* Profile details — the source's own fields (pronouns, and the like). A link
            is never one of them: links are the profile's chips. */ Embed(
        (pronouns || (profileData.fields && profileData.fields.length > 0)) &&
          toElement(
            LGroupedSection(
              Embed(
                pronouns &&
                  toElement(
                    LGroupedSectionItem(
                      t('profile.about.pronouns', { defaultValue: 'Pronouns' }),
                    ).value(pronouns),
                  ),
              ),
              Embed(
                profileData.fields?.map((field) =>
                  toElement(
                    LGroupedSectionItem(field.name).value(field.value),
                    `${field.name}:${field.value}`,
                  ),
                ),
              ),
            ).title(t('profile.about.profileDetails', { defaultValue: 'Profile details' })),
          ),
      ),
      /* Account details — dates, location, activity */ Embed(
        hasAccountDetails &&
          toElement(
            LGroupedSection(
              Embed(
                joinDate &&
                  toElement(
                    LGroupedSectionItem(
                      t('profile.about.dateJoined', { defaultValue: 'Date joined' }),
                    )
                      .leadingView(Icon(RiCalendar2Line).size('md').foreground('muted'))
                      .value(joinDate),
                  ),
              ),
              Embed(
                profileData.primaryLocation &&
                  toElement(
                    LGroupedSectionItem(
                      t('profile.about.basedIn', { defaultValue: 'Account based in' }),
                    )
                      .leadingView(Embed(<RowIcon icon={RiMapPinLine} />))
                      .value(profileData.primaryLocation),
                  ),
              ),
              Embed(
                websiteUrl &&
                  toElement(
                    LGroupedSectionItem(t('profile.about.website', { defaultValue: 'Website' }))
                      .leadingView(Embed(<RowIcon icon={RiLinkM} />))
                      .value(website?.replace(/^https?:\/\//i, ''))
                      .onPress(() => openExternalLink(websiteUrl)),
                  ),
              ),
              Embed(
                hasUsernameChanges &&
                  toElement(
                    LGroupedSectionItem(
                      t('profile.about.usernameChanges', { defaultValue: 'Username changes' }),
                    )
                      .leadingView(Embed(<RowIcon icon={RiAtLine} />))
                      .value(String(profileData.usernameChangeCount)),
                  ),
              ),
              Embed(
                profileData.connectedVia &&
                  toElement(
                    LGroupedSectionItem(
                      t('profile.about.connectedVia', { defaultValue: 'Connected via' }),
                    )
                      .leadingView(Embed(<RowIcon icon={RiEarthLine} />))
                      .value(profileData.connectedVia),
                  ),
              ),
            ).title(t('profile.about.details', { defaultValue: 'Account details' })),
          ),
      ),
      /* Verification — its own section, matching the profile's emphasis on the
              verified badge */ Embed(
        profileData.verified &&
          toElement(
            LGroupedSection(
              LGroupedSectionItem(t('profile.fields.verified', { defaultValue: 'Verified' }))
                .leadingView(
                  Embed(<RiVerifiedBadgeFill width={20} height={20} fill={VERIFIED_BADGE_COLOR} />),
                )
                .value(
                  verifiedDate
                    ? t('profile.about.since', {
                        date: verifiedDate,
                        defaultValue: `Since ${verifiedDate}`,
                      })
                    : t('profile.about.verifiedAccount', { defaultValue: 'Verified account' }),
                ),
            ).title(t('profile.about.verification', { defaultValue: 'Verification' })),
          ),
      ),
      /* Fediverse — every non-Oxy account, whichever network it lives on,
              under the same title and icon as the marker beside its name (no
              per-network chip anywhere). The ROWS still say where the account
              actually lives: the network by name, its home server, the full
              cross-network handle, and a link out to the original profile. The
              "Learn more" row opens the FediverseInfoSheet for ActivityPub
              accounts only, the network that sheet describes. */ Embed(
        federationInfo &&
          toElement(
            LGroupedSection(
              LGroupedSectionItem(t('fediverse.about.network', { defaultValue: 'Network' }))
                .leadingView(Icon(RiFediverseLine).size('md').foreground('muted'))
                .value(
                  federationInfo.network === 'atproto'
                    ? t('fediverse.about.networkBluesky', { defaultValue: 'Bluesky' })
                    : federationInfo.network === 'instagram-graph'
                      ? t('fediverse.about.networkInstagram', { defaultValue: 'Instagram' })
                      : t('fediverse.about.networkActivityPub', { defaultValue: 'ActivityPub' }),
                ),
              Embed(
                federationInfo.instance &&
                  toElement(
                    LGroupedSectionItem(
                      t('fediverse.about.homeServer', { defaultValue: 'Home server' }),
                    )
                      .leadingView(Embed(<RowIcon icon={RiDatabase2Line} />))
                      .value(federationInfo.instance),
                  ),
              ),
              Embed(
                federationInfo.handle &&
                  toElement(
                    LGroupedSectionItem(t('fediverse.about.handle', { defaultValue: 'Handle' }))
                      .leadingView(Embed(<RowIcon icon={RiAtLine} />))
                      .value(`@${federationInfo.handle}`),
                  ),
              ),
              Embed(
                federationInfo.originalProfileUrl &&
                  toElement(
                    LGroupedSectionItem(
                      t('fediverse.about.viewOriginal', { defaultValue: 'View original profile' }),
                    )
                      .leadingView(Icon(RiExternalLinkLine).size('md').foreground('muted'))
                      .onPress(() => {
                        if (federationInfo.originalProfileUrl)
                          openExternalLink(federationInfo.originalProfileUrl);
                      }),
                  ),
              ),
              federationInfo.network === 'activitypub'
                ? LGroupedSectionItem(
                    t('fediverse.about.learnMore', {
                      defaultValue: 'Learn more about the fediverse',
                    }),
                  )
                    .leadingView(Icon(RiFediverseLine).size('md').foreground('muted'))
                    .onPress(() => showFediverseInfo())
                : null,
            )
              .title(t('fediverse.about.title', { defaultValue: 'Fediverse' }))
              .caption(
                federationInfo.network === 'atproto'
                  ? t('fediverse.about.descriptionBluesky', {
                      instance: federationInfo.instance ?? BLUESKY_NETWORK_DOMAIN,
                      defaultValue:
                        'This account lives on Bluesky ({{instance}}). You can follow it and reply from Mention just like a native account.',
                    })
                  : federationInfo.network === 'instagram-graph'
                    ? t('fediverse.about.descriptionInstagram', {
                        defaultValue:
                          "This account's posts are copied from Instagram. You can follow it on Mention, but its author can't see replies or likes from here.",
                      })
                    : t('fediverse.about.descriptionActivityPub', {
                        instance: federationInfo.instance ?? '',
                        defaultValue:
                          'This account lives on another server in the fediverse ({{instance}}). You can follow it and reply from Mention just like a native account.',
                      }),
              ),
          ),
      ),
    )
      .padding('horizontal', 'xl')
      .padding('bottom', '2xl'),
  );
}
