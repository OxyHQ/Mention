import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { proxyExternalUrl } from '@/utils/imageUrlCache';

interface ExternalEmbedPosterProps {
  /** Thumbnail (link-preview image) shown behind the play button. */
  thumb?: string;
  /** Whether the underlying player surface has been mounted. */
  active: boolean;
  /** Whether the active player is still loading (show a spinner over the thumb). */
  loading: boolean;
  /** Fired when the (inactive) play button is pressed. */
  onPressPlay: () => void;
}

/**
 * Shared overlay for an external embed: the thumbnail, a dim scrim, and a center
 * play button (or a loading spinner once the player is mounting). Returns
 * nothing once the player is active and finished loading, handing the frame to
 * the platform-specific player surface (iframe / WebView). Platform-neutral —
 * used by both `ExternalEmbedPlayer.web.tsx` and `.native.tsx`.
 */
export function ExternalEmbedPoster({ thumb, active, loading, onPressPlay }: ExternalEmbedPosterProps) {
  if (active && !loading) return null;

  return (
    <View className="absolute inset-0" pointerEvents="box-none">
      {thumb ? (
        <Image
          source={{ uri: proxyExternalUrl(thumb) }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
        />
      ) : null}
      <View className="absolute inset-0 bg-black/30" />
      <Pressable
        onPress={active ? undefined : onPressPlay}
        accessibilityRole="button"
        className="flex-1 items-center justify-center"
      >
        {active ? (
          <ActivityIndicator size="large" color="white" />
        ) : (
          <View className="h-16 w-16 items-center justify-center rounded-full bg-black/60">
            <Ionicons name="play" size={32} color="white" style={{ marginLeft: 3 }} />
          </View>
        )}
      </Pressable>
    </View>
  );
}
