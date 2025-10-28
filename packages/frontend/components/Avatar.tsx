import React from 'react';
import {
  View,
  Image,
  Animated,
  StyleSheet,
  ImageSourcePropType,
  Text,
  StyleProp,
  ViewStyle,
  ImageStyle,
  TouchableOpacity,
} from 'react-native';
import { VerifiedIcon } from '@/assets/icons/verified-icon';
import { colors } from '../styles/colors';
import DefaultAvatar from '@/assets/images/default-avatar.jpg';

const AnimatedImage = Animated.createAnimatedComponent(Image);

interface AvatarProps {
  source?: ImageSourcePropType | string | undefined | null;
  size?: number;
  verified?: boolean;
  style?: StyleProp<ViewStyle>;
  imageStyle?: StyleProp<ImageStyle>;
  label?: string; // initials or single char to show when no image
  onPress?: () => void;
  useAnimated?: boolean; // render Animated.Image so parent can pass animated styles in imageStyle
}

const Avatar: React.FC<AvatarProps> = ({
  source,
  size = 40,
  verified = false,
  style,
  imageStyle,
  label,
  onPress,
  useAnimated = false,
}) => {
  const [errored, setErrored] = React.useState(false);

  const imageSource = source && !errored
    ? (typeof source === 'string' ? { uri: source } : source)
    : DefaultAvatar;

  const Container: any = onPress ? TouchableOpacity : View;

  const content = (
    <Animated.View style={[styles.container, { width: size, height: size }, style]}>
      {source && !errored ? (
        useAnimated ? (
          <AnimatedImage
            source={imageSource}
            onError={() => setErrored(true)}
            style={[styles.image, { width: size, height: size, borderRadius: size / 2 }, imageStyle]}
            defaultSource={DefaultAvatar}
          />
        ) : (
          <Image
            source={imageSource}
            onError={() => setErrored(true)}
            style={[styles.image, { width: size, height: size, borderRadius: size / 2 }, imageStyle]}
            defaultSource={DefaultAvatar}
          />
        )
      ) : (
        <View style={[styles.fallback, { width: size, height: size, borderRadius: size / 2 }]}>
          {label ? (
            <Text style={[styles.fallbackText, { fontSize: Math.round(size * 0.4) }]}>
              {label}
            </Text>
          ) : null}
        </View>
      )}

      {verified && (
        <View style={[styles.verifiedBadge, { width: size * 0.36, height: size * 0.36 }]}>
          <VerifiedIcon size={Math.round(size * 0.36)} color={colors.primaryColor} />
        </View>
      )}
    </Animated.View>
  );

  return <Container onPress={onPress}>{content}</Container>;
};

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    overflow: 'hidden',
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
  fallback: {
    backgroundColor: `${colors.primaryColor}20`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fallbackText: {
    color: colors.primaryColor,
    fontWeight: '700',
  },
});

export default React.memo(Avatar);