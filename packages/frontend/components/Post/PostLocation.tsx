import React from 'react';
import { View,      <Ionicons
  name="location-outline"
  size={14}
import { useTheme } from '@/hooks/useTheme';
  color={theme.colors.textSecondary}
  style={styles.icon}
/>
  <Text style={[styles.locationText, { color: theme.colors.textSecondary }]} numberOfLines={1}>
    {displayText}
  </Text>yleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/styles/colors';
import { GeoJSONPoint } from '@mention/shared-types';
import { useTheme } from '@/hooks/useTheme';

interface PostLocationProps {
  location: GeoJSONPoint;
  paddingHorizontal?: number;
  style?: any;
  onPress?: () => void;
}

const PostLocation: React.FC<PostLocationProps> = ({
  location,
  paddingHorizontal = 16,
  style,
  onPress
}) => {
  const theme = useTheme();

  if (!location?.coordinates?.[0] || !location?.coordinates?.[1]) {
    return null;
  }

  const longitude = location.coordinates[0];
  const latitude = location.coordinates[1];
  const address = location.address;

  // Display address if available, otherwise show coordinates
  const displayText = address || `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;

  const Container = onPress ? TouchableOpacity : View;

  return (
    <Container
      style={[styles.container, { paddingHorizontal }, style]}
      onPress={onPress}
      activeOpacity={onPress ? 0.7 : 1}
    >
      <Ionicons
        name="location-outline"
        size={14}
        color={colors.COLOR_BLACK_LIGHT_4}
        style={styles.icon}
      />
      <Text style={styles.locationText} numberOfLines={1}>
        {displayText}
      </Text>
    </Container>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
  },
  icon: {
    marginRight: 4,
  },
  locationText: {
    fontSize: 13,
    color: "#71767B",
    flex: 1,
  },
});

export default PostLocation;
