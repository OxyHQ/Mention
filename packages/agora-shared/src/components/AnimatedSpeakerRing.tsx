import React, { useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  Easing,
  cancelAnimation,
} from 'react-native-reanimated';

interface AnimatedSpeakerRingProps {
  isSpeaking: boolean;
  isMuted: boolean;
  primaryColor: string;
  children: React.ReactNode;
}

export const AnimatedSpeakerRing = React.memo(function AnimatedSpeakerRing({
  isSpeaking,
  isMuted,
  primaryColor,
  children,
}: AnimatedSpeakerRingProps) {
  const pulseScale = useSharedValue(1);
  const pulseOpacity = useSharedValue(0);

  useEffect(() => {
    if (isSpeaking && !isMuted) {
      pulseOpacity.value = withRepeat(
        withSequence(
          withTiming(0.4, { duration: 600, easing: Easing.out(Easing.ease) }),
          withTiming(0, { duration: 600, easing: Easing.in(Easing.ease) }),
        ),
        -1,
        false,
      );
      pulseScale.value = withRepeat(
        withSequence(
          withTiming(1.15, { duration: 600, easing: Easing.out(Easing.ease) }),
          withTiming(1, { duration: 600, easing: Easing.in(Easing.ease) }),
        ),
        -1,
        false,
      );
    } else {
      cancelAnimation(pulseScale);
      cancelAnimation(pulseOpacity);
      pulseScale.value = withTiming(1, { duration: 200 });
      pulseOpacity.value = withTiming(0, { duration: 200 });
    }
  }, [isSpeaking, isMuted, pulseScale, pulseOpacity]);

  const pulseStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulseScale.value }],
    opacity: pulseOpacity.value,
  }));

  return (
    <View style={styles.container}>
      <Animated.View
        style={[
          styles.pulseRing,
          { borderColor: primaryColor },
          pulseStyle,
        ]}
      />
      <View
        style={[
          styles.avatarRing,
          !isMuted
            ? { borderColor: primaryColor, borderWidth: 3 }
            : { borderColor: 'transparent', borderWidth: 3 },
        ]}
      >
        {children}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  pulseRing: {
    position: 'absolute',
    width: '100%',
    height: '100%',
    borderRadius: 19,
    borderWidth: 3,
  },
  avatarRing: {
    borderRadius: 19,
    padding: 2,
    position: 'relative',
  },
});
