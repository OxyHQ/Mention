import React, { memo, useCallback, useEffect, useReducer, useRef } from 'react';
import { View, Text, StyleSheet, Platform, type ViewProps } from 'react-native';
import { SpinnerIcon } from '@oxyhq/bloom/loading';
import { ActivityHeatmap } from '@oxyhq/bloom/activity-heatmap';
import { useRouter } from 'expo-router';
import { flip, offset, shift, size, useFloating } from '@floating-ui/react-dom';
import { FollowButton } from '@oxyhq/services/ui/client';
import { getNormalizedUserHandle } from '@oxyhq/core';

import { BloomColorScope, useTheme } from '@oxyhq/bloom/theme';
import { useProfileData, usePrefetchProfile } from '@/hooks/useProfileData';
import { resolveProfileColorName } from '@/hooks/useProfileScreenColor';
import { usePostActivity } from '@/hooks/usePostActivity';
import { formatCompactNumber } from '@/utils/formatNumber';
import { Portal } from '@oxyhq/bloom/portal';
import { Avatar } from '@oxyhq/bloom/avatar';
import { MEDIA_VARIANT_AVATAR_LG } from '@mention/shared-types/post';
import UserName from '@/components/UserName';
import { RemoteActorBadge } from '@/components/Fediverse/FediverseBadge';
import { useFederatedFollowSync } from '@/components/Profile/hooks/useFederatedFollowSync';
import { type ProfileHoverCardProps } from './types';

const IS_TOUCH_DEVICE = typeof window !== 'undefined' && 'ontouchstart' in window;

/**
 * The props the hover target carries: floating-ui's reference node plus the
 * pointer handlers that drive the state machine. react-native-web forwards
 * `onMouseUp` and resolves a component ref to the DOM element, but RN's own
 * `ViewProps`/`TextProps` model neither — so the target types are widened here,
 * once, instead of per-line type suppressions. (Same "extend the type" approach
 * SideBar uses for its web-only sticky style.)
 */
interface HoverTargetProps {
  ref?: (node: Element | null) => void;
  onPointerMove?: () => void;
  onPointerLeave?: () => void;
  onMouseUp?: () => void;
}
type WebViewProps = Omit<ViewProps, 'ref'> & HoverTargetProps;
const WebView = View as unknown as React.ComponentType<WebViewProps>;

const floatingMiddlewares = [
  offset(4),
  flip({ padding: 16 }),
  shift({ padding: 16 }),
  size({
    padding: 16,
    apply({ availableWidth, availableHeight, elements }) {
      Object.assign(elements.floating.style, {
        maxWidth: `${availableWidth}px`,
        maxHeight: `${availableHeight}px`,
      });
    },
  }),
];

export function ProfileHoverCard({ username, ...props }: ProfileHoverCardProps) {
  // No handle ⇒ nothing to preview (degraded author) — render the target alone.
  // Every hook lives in the inner component, which only mounts when the card is
  // actually live, so this early return can never reorder hooks.
  if (!username || props.disable || IS_TOUCH_DEVICE) {
    return props.children as React.ReactElement;
  }

  return <ProfileHoverCardInner {...props} username={username} />;
}

// --- State machine ---

type State =
  | { stage: 'hidden' | 'might-hide' | 'hiding'; effect?: () => () => void }
  | { stage: 'might-show' | 'showing'; effect?: () => () => void; reason: 'hovered-target' | 'hovered-card' };

type Action =
  | 'pressed'
  | 'scrolled-while-showing'
  | 'hovered-target'
  | 'unhovered-target'
  | 'hovered-card'
  | 'unhovered-card'
  | 'hovered-long-enough'
  | 'unhovered-long-enough'
  | 'finished-animating-hide';

const SHOW_DELAY = 500;
const SHOW_DURATION = 300;
const HIDE_DELAY = 150;
const HIDE_DURATION = 200;

function ProfileHoverCardInner(props: ProfileHoverCardProps & { username: string }) {
  const prefetchProfile = usePrefetchProfile();
  const { refs, floatingStyles } = useFloating({
    middleware: floatingMiddlewares,
  });

  const [currentState, dispatch] = useReducer(
    (state: State, action: Action): State => {
      if (action === 'pressed') {
        return hidden();
      }

      function hidden(): State {
        return { stage: 'hidden' };
      }
      if (state.stage === 'hidden') {
        if (action === 'hovered-target') {
          return mightShow({ reason: action });
        }
      }

      function mightShow({
        waitMs = SHOW_DELAY,
        reason,
      }: {
        waitMs?: number;
        reason: 'hovered-target' | 'hovered-card';
      }): State {
        return {
          stage: 'might-show',
          reason,
          effect() {
            const id = setTimeout(() => dispatch('hovered-long-enough'), waitMs);
            return () => clearTimeout(id);
          },
        };
      }
      if (state.stage === 'might-show') {
        if (action === 'unhovered-target' || action === 'unhovered-card') {
          return hidden();
        }
        if (action === 'hovered-long-enough') {
          return showing({ reason: state.reason });
        }
      }

      function showing({
        reason,
      }: {
        reason: 'hovered-target' | 'hovered-card';
      }): State {
        return {
          stage: 'showing',
          reason,
          effect() {
            function onScroll() {
              dispatch('scrolled-while-showing');
            }
            window.addEventListener('scroll', onScroll, { passive: true });
            return () => window.removeEventListener('scroll', onScroll);
          },
        };
      }
      if (state.stage === 'showing') {
        if (action === 'unhovered-target' || action === 'unhovered-card') {
          return mightHide();
        }
        if (state.reason === 'hovered-target' && action === 'scrolled-while-showing') {
          return hiding();
        }
      }

      function mightHide({ waitMs = HIDE_DELAY }: { waitMs?: number } = {}): State {
        return {
          stage: 'might-hide',
          effect() {
            const id = setTimeout(() => dispatch('unhovered-long-enough'), waitMs);
            return () => clearTimeout(id);
          },
        };
      }
      if (state.stage === 'might-hide') {
        if (action === 'hovered-target' || action === 'hovered-card') {
          return showing({ reason: action });
        }
        if (action === 'unhovered-long-enough') {
          return hiding();
        }
      }

      function hiding({ animationDurationMs = HIDE_DURATION }: { animationDurationMs?: number } = {}): State {
        return {
          stage: 'hiding',
          effect() {
            const id = setTimeout(() => dispatch('finished-animating-hide'), animationDurationMs);
            return () => clearTimeout(id);
          },
        };
      }
      if (state.stage === 'hiding') {
        if (action === 'finished-animating-hide') {
          return hidden();
        }
      }

      return state;
    },
    { stage: 'hidden' },
  );

  useEffect(() => {
    if (currentState.effect) {
      const effect = currentState.effect;
      return effect();
    }
  }, [currentState]);

  const didFireHover = useRef(false);
  const onPointerMoveTarget = useCallback(() => {
    if (!didFireHover.current) {
      didFireHover.current = true;
      // Warm the profile query the card reads BEFORE the open delay elapses, so
      // the card usually mounts with data instead of a spinner. Once per hover:
      // the flag resets on pointer-leave, and a warm entry is a no-op anyway.
      prefetchProfile(props.username);
      dispatch('hovered-target');
    }
  }, [prefetchProfile, props.username]);

  const onPointerLeaveTarget = useCallback(() => {
    didFireHover.current = false;
    dispatch('unhovered-target');
  }, []);

  const onPointerEnterCard = useCallback(() => {
    dispatch('hovered-card');
  }, []);

  const onPointerLeaveCard = useCallback(() => {
    dispatch('unhovered-card');
  }, []);

  const onPress = useCallback(() => {
    dispatch('pressed');
  }, []);

  const isVisible =
    currentState.stage === 'showing' ||
    currentState.stage === 'might-hide' ||
    currentState.stage === 'hiding';

  const animationStyle = {
    animation:
      currentState.stage === 'hiding'
        ? `profileHoverCardFadeOut ${HIDE_DURATION}ms both`
        : `profileHoverCardFadeIn ${SHOW_DURATION}ms both`,
  };

  // floating-ui's `setReference` takes a DOM node; on react-native-web a
  // component ref resolves to that node. `onMouseUp` is a web-only prop.
  const targetProps: HoverTargetProps = {
    ref: refs.setReference,
    onPointerMove: onPointerMoveTarget,
    onPointerLeave: onPointerLeaveTarget,
    onMouseUp: onPress,
  };

  // An INLINE target (a `@mention` inside a paragraph) becomes the hover target
  // itself: react-native-web renders a `View` as a block-level flex box, which
  // an enclosing `Text` takes out of the line flow — the mention would sit on
  // its own line, overlapping the body copy. So the handlers are attached to the
  // caller's own element instead of a wrapper. Every other target keeps the
  // wrapper, which is also where the caller's layout `style` lands.
  const target = props.inline ? (
    React.cloneElement(
      React.Children.only(props.children) as React.ReactElement<HoverTargetProps>,
      targetProps,
    )
  ) : (
    <WebView {...targetProps} style={[{ flexShrink: 1 }, props.style]}>
      {props.children}
    </WebView>
  );

  return (
    <>
      {target}
      {isVisible && (
        <Portal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            onPointerEnter={onPointerEnterCard}
            onPointerLeave={onPointerLeaveCard}>
            <div style={{ willChange: 'transform', ...animationStyle }}>
              <Card username={props.username} hide={onPress} />
            </div>
          </div>
        </Portal>
      )}
    </>
  );
}

// --- Card ---

let Card = ({
  username,
  hide,
}: {
  username: string;
  hide: () => void;
}): React.ReactNode => {
  const theme = useTheme();
  const router = useRouter();
  const { data: profile, loading } = useProfileData(username);

  // The card is a small piece of that profile, so it wears the profile's own
  // color exactly as the profile screen does — scoped to this subtree, never
  // published to the screen underneath (see `resolveProfileColorName`).
  const profileColorName = resolveProfileColorName(username, profile?.design?.color);

  const isFederated = profile?.isFederated;
  const instance = profile?.instance;
  const profileUsername = profile?.username;

  const handlePressProfile = useCallback(() => {
    hide();
    const handle = getNormalizedUserHandle({
      username: profileUsername || username,
      instance,
      isFederated,
    });
    if (handle) {
      router.push(`/@${handle}`);
    }
  }, [hide, router, username, isFederated, instance, profileUsername]);

  return (
    <BloomColorScope colorPreset={profileColorName} asChild>
      <View
        className="bg-card border-border"
        style={{
          width: 300,
          padding: 16,
          // The same corner Bloom gives its own floating surfaces (Dialog,
          // SheetShell) — this is one of them, not a card in the page flow.
          borderRadius: 20,
          borderWidth: StyleSheet.hairlineWidth,
          shadowColor: theme.colors.text,
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.12,
          shadowRadius: 12,
          elevation: 8,
        }}>
        {profile && !loading ? (
          <CardContent profile={profile} username={username} hide={hide} onPressProfile={handlePressProfile} />
        ) : (
          <View className="items-center justify-center" style={{ minHeight: 120 }}>
            <SpinnerIcon size={20} className="text-primary" />
          </View>
        )}
      </View>
    </BloomColorScope>
  );
};
Card = memo(Card);

function CardContent({
  profile,
  username,
  hide,
  onPressProfile,
}: {
  profile: NonNullable<ReturnType<typeof useProfileData>['data']>;
  username: string;
  hide: () => void;
  onPressProfile: () => void;
}) {
  // Bridge an Oxy follow of a federated actor to the ActivityPub layer, the same
  // way the full profile screen does — so following from the hover card actually
  // sends the remote Follow (not just a local Oxy edge).
  useFederatedFollowSync(profile.id, profile.isFederated, profile.actorUri);

  const followersCount = profile.followersCount ?? 0;
  const followingCount = profile.followingCount ?? 0;

  // Post-activity contribution graph. Empty while loading, for private profiles
  // the viewer can't see, or for federated actors with no local post history —
  // in which case the section is hidden rather than shifting the card layout.
  const activity = usePostActivity(profile.id);
  const activityEndDate = new Date().toISOString().slice(0, 10);

  return (
    <View>
      <View className="flex-row justify-between items-start">
        <View
          style={Platform.select({ web: { cursor: 'pointer' }, default: {} })}
          onPointerUp={onPressProfile}>
          <Avatar
            source={profile.design.avatar || profile.avatar}
            size={64}
            variant={MEDIA_VARIANT_AVATAR_LG}
            verified={profile.verified}
          />
        </View>

        {FollowButton && profile.id && (
          <FollowButton userId={profile.id} size="small" />
        )}
      </View>

      <View
        style={Platform.select({
          web: { cursor: 'pointer', paddingTop: 8, paddingBottom: 4 },
          default: { paddingTop: 8, paddingBottom: 4 },
        })}
        onPointerUp={onPressProfile}>
        <View className="flex-row items-center">
          <UserName
            name={profile.design.displayName}
            verified={profile.verified}
          />
        </View>

        <View className="flex-row items-center gap-1 mt-0.5">
          <Text className="text-muted-foreground text-sm" style={{ lineHeight: 18 }} numberOfLines={1}>
            @{profile.isFederated && profile.username?.includes('@')
              ? profile.username.split('@')[0]
              : profile.username}
          </Text>
          {profile.isFederated && profile.instance && (
            <Text className="text-muted-foreground text-xs">@{profile.instance}</Text>
          )}
          {profile.isFederated && (
            <RemoteActorBadge size={13} className="text-muted-foreground" />
          )}
        </View>
      </View>

      <View className="flex-row gap-4 pt-2">
        <View className="flex-row items-center">
          <Text className="text-foreground text-sm font-semibold">
            {formatCompactNumber(followersCount)}
          </Text>
          <Text className="text-muted-foreground text-sm">
            {' '}{followersCount === 1 ? 'follower' : 'followers'}
          </Text>
        </View>
        <View className="flex-row items-center">
          <Text className="text-foreground text-sm font-semibold">
            {formatCompactNumber(followingCount)}
          </Text>
          <Text className="text-muted-foreground text-sm">
            {' '}following
          </Text>
        </View>
      </View>

      {profile.bio ? (
        <View className="pt-2">
          <Text
            className="text-muted-foreground text-sm"
            style={{ lineHeight: 20 }}
            numberOfLines={3}>
            {profile.bio}
          </Text>
        </View>
      ) : null}

      {activity.length > 0 ? (
        <View className="pt-3">
          <Text className="text-muted-foreground text-sm">Activity</Text>
          {/* 119 days (17 weeks) at 11px cells + 3px gaps ≈ 249px worst case,
              fitting the card's ~268px inner width without horizontal scroll.
              No weekday/month labels — too cramped for a hover card. */}
          <View className="pt-1">
            <ActivityHeatmap
              data={activity}
              endDate={activityEndDate}
              numDays={119}
              cellSize={11}
              gap={3}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}
