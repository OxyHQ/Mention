import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet } from 'react-native';
import { colors } from '../../styles/colors';

export const LoadingTopSpinner = () => {
  const spinAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.8)).current;

  useEffect(() => {
    // Rotation animation
    Animated.loop(
      Animated.sequence([
        Animated.timing(spinAnim, {
          toValue: 1,
          duration: 1000,
          useNativeDriver: true,
        })
      ])
    ).start();

    // Scale animation
    Animated.spring(scaleAnim, {
      toValue: 1,
      tension: 20,
      friction: 5,
      useNativeDriver: true,
    }).start();
  }, []);

  return (
    <Animated.View style={[
      styles.spinner,
      {
        transform: [
          {
            rotate: spinAnim.interpolate({
              inputRange: [0, 1],
              outputRange: ['0deg', '360deg']
            })
          },
          { scale: scaleAnim }
        ]
      }
    ]} />
  );
};

const styles = StyleSheet.create({
  spinner: {
    width: 24,
    aspectRatio: 1,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: colors.primaryColor,
    borderTopColor: 'transparent',
    marginVertical: 8,
    alignSelf: 'center'
  }
});