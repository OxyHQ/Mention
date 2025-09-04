import React from 'react';
import {
  View,
  Image,
  StyleSheet,
  ImageSourcePropType
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../styles/colors';
import DefaultAvatar from '@/assets/images/default-avatar.jpg';

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
  const imageSource = source ? (typeof source === 'string' ? { uri: source } : source) : DefaultAvatar;

  return (
    <View style={[styles.container, { width: size, height: size }, style]}>
      <Image
        source={imageSource}
        style={[styles.image, { width: size, height: size, borderRadius: size / 2 }]}
        defaultSource={DefaultAvatar}
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