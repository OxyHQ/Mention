/**
 * ThemedText Component
 * 
 * A text component with theme-aware styling.
 */

import React from 'react';
import { Text, TextProps, StyleSheet } from 'react-native';
import { colors } from '../../styles/colors';

interface ThemedTextProps extends TextProps {
  variant?: 'body' | 'title' | 'subtitle' | 'caption';
}

export function ThemedText({ 
  children, 
  style, 
  variant = 'body',
  ...props 
}: ThemedTextProps) {
  return (
    <Text 
      style={[styles[variant], style]} 
      {...props}
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  body: {
    color: colors.COLOR_BLACK,
    fontSize: 16,
  },
  title: {
    color: colors.COLOR_BLACK,
    fontSize: 24,
    fontWeight: 'bold',
  },
  subtitle: {
    color: colors.COLOR_BLACK_LIGHT_4,
    fontSize: 18,
    fontWeight: '500',
  },
  caption: {
    color: colors.COLOR_BLACK_LIGHT_5,
    fontSize: 14,
  },
});