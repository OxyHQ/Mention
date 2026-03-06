import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

import type { AgoraTheme } from '../types';

interface PanelHeaderProps {
  title: string;
  theme: AgoraTheme;
  onBack: () => void;
}

export function PanelHeader({ title, theme, onBack }: PanelHeaderProps) {
  return (
    <View style={[styles.header, { borderBottomColor: `${theme.colors.border}80` }]}>
      <TouchableOpacity onPress={onBack} style={styles.side}>
        <MaterialCommunityIcons name="arrow-left" size={24} color={theme.colors.text} />
      </TouchableOpacity>
      <Text style={[styles.title, { color: theme.colors.text }]}>{title}</Text>
      <View style={styles.side} />
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  side: { width: 40, alignItems: 'center' },
  title: { fontSize: 17, fontWeight: '600' },
});
