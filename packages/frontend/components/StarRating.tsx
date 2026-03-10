import React, { useMemo } from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

interface StarRatingProps {
  rating: number;
  size?: number;
  color: string;
  interactive?: boolean;
  onRate?: (value: number) => void;
}

const StarRating = React.memo(function StarRating({
  rating,
  size = 16,
  color,
  interactive = false,
  onRate,
}: StarRatingProps) {
  const stars = useMemo(
    () =>
      Array.from({ length: 5 }, (_, i) => ({
        key: i,
        filled: interactive ? i < rating : i < Math.round(rating),
      })),
    [rating, interactive]
  );

  return (
    <View style={styles.row}>
      {stars.map(({ key, filled }) =>
        interactive ? (
          <TouchableOpacity
            key={key}
            onPress={() => onRate?.(key + 1)}
            hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
          >
            <Ionicons name={filled ? 'star' : 'star-outline'} size={size} color={color} />
          </TouchableOpacity>
        ) : (
          <Ionicons key={key} name={filled ? 'star' : 'star-outline'} size={size} color={color} />
        )
      )}
    </View>
  );
});

export default StarRating;

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 1,
  },
});
