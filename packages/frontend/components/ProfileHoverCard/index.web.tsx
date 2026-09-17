import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@oxy.so/bloom/hover-card';
import { UserHoverCard } from '@oxy.so/bloom/user-hover-card';
import { ActivityHeatmap } from '@oxy.so/bloom/activity-heatmap';
import { BloomColorScope } from '@oxy.so/bloom/theme';
import { Muted } from '@oxy.so/bloom/typography';
import { FollowButton } from '@oxy.so/services/ui/client';
import { MEDIA_VARIANT_AVATAR_LG } from '@mention/shared-types/post';
import { profileHrefForUser } from '@/components/Profile/profileRoute';
import { useFederatedFollowSync } from '@/components/Profile/hooks/useFederatedFollowSync';
import { AccountBadge } from '@/components/AccountBadge';
import { useProfileData } from '@/hooks/useProfileData';
import { resolveProfileColorName } from '@/hooks/useProfileScreenColor';
import { usePostActivity } from '@/hooks/usePostActivity';
import { formatCompactNumber } from '@/utils/formatNumber';
import { type ProfileHoverCardProps } from './types';

/**
 * A profile preview on hover. Bloom owns WHEN and WHERE it appears (`HoverCard`:
 * the open/close delays, the bridge onto the card, placement, Escape and outside
 * presses, touch pointers ignored) and HOW it looks (`UserHoverCard`); this file
 * only supplies the person — the profile, the follow action and the activity graph.
 */
export function ProfileHoverCard({ username, disable, style, children }: ProfileHoverCardProps) {
  // No handle ⇒ nothing to preview (degraded author): render the target alone.
  if (!username || disable) {
    return children as React.ReactElement;
  }
  return (
    <ProfileHoverCardLive username={username} style={style}>
      {children}
    </ProfileHoverCardLive>
  );
}

function ProfileHoverCardLive({
  username,
  style,
  children,
}: Pick<ProfileHoverCardProps, 'style' | 'children'> & { username: string }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  return (
    <HoverCard open={open} onOpenChange={setOpen}>
      <HoverCardTrigger style={style}>{children}</HoverCardTrigger>
      <HoverCardContent label={username}>
        {/* Mounted only while open, so the profile is fetched on open, not on render. */}
        {open ? <ProfilePreview username={username} onNavigate={close} /> : null}
      </HoverCardContent>
    </HoverCard>
  );
}

function ProfilePreview({ username, onNavigate }: { username: string; onNavigate: () => void }) {
  const { t } = useTranslation();
  const router = useRouter();
  const { data: profile, loading } = useProfileData(username);

  // Following from the card has to reach the ActivityPub layer too, exactly as
  // it does from the profile screen.
  useFederatedFollowSync(profile?.id, profile?.isFederated, profile?.actorUri);
  // Empty while loading, for private profiles and for federated actors with no
  // local posts — the footer is then omitted rather than drawn empty.
  const activity = usePostActivity(profile?.id);

  const handlePressProfile = useCallback(() => {
    const href = profileHrefForUser({
      username: profile?.username || username,
      instance: profile?.instance,
      isFederated: profile?.isFederated,
    });
    onNavigate();
    if (href) router.push(href);
  }, [onNavigate, router, username, profile?.username, profile?.instance, profile?.isFederated]);

  // The card is a small piece of that profile, so it wears the profile's own
  // colour, scoped to this subtree (see `resolveProfileColorName`).
  const colorName = resolveProfileColorName(username, profile?.design?.color);

  return (
    <BloomColorScope colorPreset={colorName}>
      <UserHoverCard
        loading={!profile || loading}
        avatar={profile?.design.avatar || profile?.avatar}
        variant={MEDIA_VARIANT_AVATAR_LG}
        displayName={profile?.design.displayName?.trim() || username}
        username={profile?.username || username}
        verified={profile?.verified}
        badge={
          profile ? (
            <AccountBadge
              isFederated={profile.isFederated}
              kind={profile.kind}
              size={13}
              className="text-muted-foreground"
            />
          ) : undefined
        }
        bio={profile?.bio || undefined}
        stats={
          profile
            ? [
                {
                  label: t('profile.followers', { defaultValue: 'Followers' }),
                  value: formatCompactNumber(profile.followersCount ?? 0),
                },
                {
                  label: t('profile.following', { defaultValue: 'Following' }),
                  value: formatCompactNumber(profile.followingCount ?? 0),
                },
              ]
            : undefined
        }
        action={profile?.id ? <FollowButton userId={profile.id} size="small" /> : undefined}
        onPressProfile={handlePressProfile}
        footer={
          activity.length > 0 ? (
            <View style={{ gap: 4 }}>
              <Muted>{t('profile.activity', { defaultValue: 'Activity' })}</Muted>
              {/* 119 days is 18 columns at 11px + 3px gaps: 249px, inside the
                  card's 256px content width. */}
              <ActivityHeatmap
                data={activity}
                endDate={new Date().toISOString().slice(0, 10)}
                numDays={119}
                cellSize={11}
                gap={3}
              />
            </View>
          ) : undefined
        }
      />
    </BloomColorScope>
  );
}
