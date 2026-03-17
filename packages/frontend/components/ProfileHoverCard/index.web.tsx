import React, { memo, useCallback, useEffect, useReducer, useRef } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { flip, offset, shift, size, useFloating } from '@floating-ui/react-dom';
import * as OxyServicesNS from '@oxyhq/services';

import { useTheme } from '@oxyhq/bloom/theme';
import { useProfileData } from '@/hooks/useProfileData';
import { formatCompactNumber } from '@/utils/formatNumber';
import { Portal } from '@/components/Portal';
import { Avatar } from '@oxyhq/bloom/avatar';
import UserName from '@/components/UserName';
import { FediverseIcon } from '@/assets/icons/fediverse-icon';
import { type ProfileHoverCardProps } from './types';

const FollowButton = (OxyServicesNS as any).FollowButton as React.ComponentType<{
  userId: string;
  size?: 'small' | 'medium' | 'large';
}> | undefined;

const IS_TOUCH_DEVICE = typeof window !== 'undefined' && 'ontouchstart' in window;

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

export function ProfileHoverCard(props: ProfileHoverCardProps) {
  if (props.disable || IS_TOUCH_DEVICE) {
    return props.children as React.ReactElement;
  }

  return (
    <View style={[{ flexShrink: 1 }, props.inline && { display: 'inline-flex' as any }, props.style]}>
      <ProfileHoverCardInner {...props} />
    </View>
  );
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

function ProfileHoverCardInner(props: ProfileHoverCardProps) {
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
      dispatch('hovered-target');
    }
  }, []);

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

  return (
    <View
      // @ts-ignore View ref used as div ref for floating-ui
      ref={refs.setReference}
      onPointerMove={onPointerMoveTarget}
      onPointerLeave={onPointerLeaveTarget}
      // @ts-ignore web only prop
      onMouseUp={onPress}
      style={[{ flexShrink: 1 }, props.inline && { display: 'inline-flex' as any }]}>
      {props.children}
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
    </View>
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

  const profileIsFederated = profile?.isFederated;
  const profileInstance = profile?.instance;
  const profileUsername = profile?.username;

  const handlePressProfile = useCallback(() => {
    hide();
    if (profileIsFederated && profileInstance) {
      router.push(`/@${profileUsername}@${profileInstance}` as any);
    } else {
      router.push(`/@${username}` as any);
    }
  }, [hide, router, username, profileIsFederated, profileInstance, profileUsername]);

  return (
    <View
      className="bg-card border-border"
      style={{
        width: 300,
        padding: 16,
        borderRadius: 12,
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
          <ActivityIndicator size="small" color={theme.colors.primary} />
        </View>
      )}
    </View>
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
  const theme = useTheme();

  const followersCount = profile.followersCount ?? 0;
  const followingCount = profile.followingCount ?? 0;

  return (
    <View>
      <View className="flex-row justify-between items-start">
        <View
          style={Platform.select({ web: { cursor: 'pointer' }, default: {} })}
          onPointerUp={onPressProfile}>
          <Avatar
            source={profile.design.avatar || profile.avatar}
            size={64}
            verified={profile.verified}
          />
        </View>

        {FollowButton && profile.id && !profile.isFederated && (
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
            name={profile.design.displayName || profile.username}
            verified={profile.verified}
          />
        </View>

        <View className="flex-row items-center gap-1 mt-0.5">
          <Text className="text-muted-foreground text-sm" style={{ lineHeight: 18 }} numberOfLines={1}>
            @{profile.username}
          </Text>
          {profile.isFederated && (
            <FediverseIcon size={13} className="text-muted-foreground" />
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
    </View>
  );
}
