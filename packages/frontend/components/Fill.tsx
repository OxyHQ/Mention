import React from 'react';
import { View, StyleSheet, ViewStyle } from 'react-native';

interface FillProps {
  children?: React.ReactNode;
  style?: ViewStyle;
}

/**
 * Fill Component
 * 
 * A layout utility component that fills its parent container.
 * Uses absolute positioning with inset-0 to fill the parent.
 * Reused from social-app.
 */
export function Fill({ children, style }: FillProps) {
  return (
    <View style={[styles.fill, style]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
});

