import React from 'react';
import {
  View,
  Image,
  StyleSheet,
  StyleProp,
  ViewStyle,
} from 'react-native';

interface AvatarProps {
  source?: string | null;
  size?: number;
  shape?: 'circle' | 'squircle';
  style?: StyleProp<ViewStyle>;
}

const DEFAULT_AVATAR = 'https://api.dicebear.com/7.x/shapes/png?seed=default';

const Avatar: React.FC<AvatarProps> = ({
  source,
  size = 40,
  shape = 'circle',
  style,
}) => {
  const [errored, setErrored] = React.useState(false);
  const radius = shape === 'circle' ? size / 2 : size * 0.22;

  const imageSource = source && !errored
    ? { uri: typeof source === 'string' ? source : undefined }
    : { uri: DEFAULT_AVATAR };

  return (
    <View style={[styles.container, { width: size, height: size, borderRadius: radius, overflow: 'hidden' }, style]}>
      <Image
        source={imageSource}
        style={{ width: size, height: size, borderRadius: radius }}
        resizeMode="cover"
        onError={() => setErrored(true)}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#E5E5EA',
  },
});

export default React.memo(Avatar);
