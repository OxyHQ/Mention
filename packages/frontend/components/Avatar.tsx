import React from 'react';
import {
  View,
  Image,
  StyleSheet,
  ImageSourcePropType
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../styles/colors';

interface AvatarProps {
  source?: ImageSourcePropType | string;
  size?: number;
  verified?: boolean;
  style?: any;
}

const Avatar: React.FC<AvatarProps> = ({
  source,
  size = 40,
  verified = false,
  style
}) => {
  const imageSource = typeof source === 'string' ? { uri: source } : source;
  const defaultSource = { uri: 'https://via.placeholder.com/40' };

  return (
    <View style={[styles.container, { width: size, height: size }, style]}>
      <Image
        source={imageSource || defaultSource}
        style={[styles.image, { width: size, height: size, borderRadius: size / 2 }]}
        defaultSource={defaultSource}
      />
      {verified && (
        <View style={[styles.verifiedBadge, { width: size * 0.4, height: size * 0.4 }]}>
          <Ionicons
            name="checkmark-circle"
            size={size * 0.4}
            color={colors.primaryColor}
          />
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: 'relative',
  },
  image: {
    resizeMode: 'cover',
  },
  verifiedBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
            backgroundColor: colors.COLOR_BLACK_LIGHT_9,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
});

export default Avatar;